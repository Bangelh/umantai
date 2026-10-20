#!/usr/bin/env node
/**
 * scripts/load-baseline.mjs — baseline reproducible de carga MODERADA.
 *
 * No es un benchmark ni promete SLA. Mide el staging real con concurrencia baja:
 *
 *   SMOKE_BASE_URL=https://staging... node scripts/load-baseline.mjs
 *   --requests=20 --concurrency=5
 *
 * Endpoints:
 *   · /api/search            (búsqueda global)
 *   · /api/search?lat&lng    (tiendas cercanas / búsqueda con radio)
 *   · /<store>               (vitrina)
 *   · /<store>/p/<product>   (detalle, descubierto desde la vitrina)
 *   · /api/health
 *
 * Salida: tabla + JSON con p50/p95/error rate por endpoint.
 */

const base = (process.env.SMOKE_BASE_URL || 'https://web-staging-6756.up.railway.app').replace(
  /\/+$/,
  '',
);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const requests = Math.max(1, Number(arg('requests', process.env.LOAD_REQUESTS || 20)));
const concurrency = Math.max(1, Number(arg('concurrency', process.env.LOAD_CONCURRENCY || 5)));
const storeSlug = arg('store', process.env.LOAD_STORE || 'hilos-y-estilo');

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1));
  return sorted[index];
}

async function discoverProductPath() {
  try {
    const response = await fetch(`${base}/${storeSlug}`, { signal: AbortSignal.timeout(15_000) });
    const html = await response.text();
    const match = html.match(new RegExp(`/${storeSlug}/p/([a-z0-9-]+)`));
    return match ? `/${storeSlug}/p/${match[1]}` : null;
  } catch {
    return null;
  }
}

async function measure(path) {
  const times = [];
  let errors = 0;
  let status = 0;

  const workers = Array.from({ length: Math.min(concurrency, requests) }, async (_, worker) => {
    for (let index = worker; index < requests; index += concurrency) {
      const started = performance.now();
      try {
        const response = await fetch(`${base}${path}`, {
          signal: AbortSignal.timeout(20_000),
          headers: { accept: path.startsWith('/api/') ? 'application/json' : 'text/html' },
        });
        status = response.status;
        if (!response.ok) errors += 1;
        await response.arrayBuffer();
      } catch {
        errors += 1;
      } finally {
        times.push(performance.now() - started);
      }
    }
  });

  await Promise.all(workers);
  times.sort((a, b) => a - b);
  return {
    path,
    requests: times.length,
    concurrency,
    p50Ms: Math.round(percentile(times, 0.5)),
    p95Ms: Math.round(percentile(times, 0.95)),
    maxMs: Math.round(times[times.length - 1] ?? 0),
    errorRate: Number((errors / Math.max(1, times.length)).toFixed(4)),
    status,
  };
}

const productPath = await discoverProductPath();
const endpoints = [
  '/api/search?q=arroz&limit=20',
  '/api/search?lat=-12.0464&lng=-77.0428&radius=10&limit=20',
  `/${storeSlug}`,
  ...(productPath ? [productPath] : []),
  '/api/health',
];

const rows = [];
for (const path of endpoints) {
  const row = await measure(path);
  rows.push(row);
  console.info(
    `${path.padEnd(58)} n=${row.requests} conc=${row.concurrency} ` +
      `p50=${row.p50Ms}ms p95=${row.p95Ms}ms max=${row.maxMs}ms err=${(row.errorRate * 100).toFixed(1)}%`,
  );
}

const ok = rows.every((row) => row.errorRate === 0);
console.info(
  JSON.stringify(
    {
      ok,
      base,
      generatedAt: new Date().toISOString(),
      note: 'Carga moderada, no destructiva. No constituye SLA.',
      rows,
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
