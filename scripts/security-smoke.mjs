#!/usr/bin/env node
/**
 * scripts/security-smoke.mjs — verificación de hardening contra un entorno YA
 * desplegado (staging por defecto). No requiere credenciales ni toca datos.
 *
 * Uso:
 *   node scripts/security-smoke.mjs
 *   SMOKE_BASE_URL=https://... node scripts/security-smoke.mjs
 *   node scripts/security-smoke.mjs --load 40
 *
 * Comprueba headers, CSRF por origen, rate limit de credenciales, rutas de
 * admin/uploads sin sesión y una carga ligera (no es un benchmark).
 */

const base = (process.env.SMOKE_BASE_URL || 'https://web-staging-6756.up.railway.app').replace(
  /\/+$/,
  '',
);
const loadCount = Number(
  process.argv.includes('--load')
    ? process.argv[process.argv.indexOf('--load') + 1]
    : process.env.SMOKE_LOAD_COUNT || 0,
);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.info(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchText(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  return { response, body };
}

// 1. Headers de seguridad.
try {
  const { response } = await fetchText('/');
  const headers = response.headers;
  const checks = [
    ['content-security-policy', headers.get('content-security-policy')?.includes("default-src 'self'")],
    ['x-frame-options', headers.get('x-frame-options') === 'DENY'],
    ['x-content-type-options', headers.get('x-content-type-options') === 'nosniff'],
    ['referrer-policy', headers.get('referrer-policy') === 'strict-origin-when-cross-origin'],
    ['permissions-policy', (headers.get('permissions-policy') ?? '').includes('camera=()')],
    ['strict-transport-security', (headers.get('strict-transport-security') ?? '').includes('max-age=')],
  ];
  for (const [name, ok] of checks) record(`header ${name}`, Boolean(ok));
  record('home 200', response.status === 200, String(response.status));
} catch (error) {
  record('home', false, error instanceof Error ? error.message : String(error));
}

// 2. CSRF: origen ajeno en una mutación.
try {
  const { response, body } = await fetchText('/api/admin/session', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  let code = null;
  try {
    code = JSON.parse(body).code;
  } catch {
    code = null;
  }
  record('CSRF origen ajeno → 403', response.status === 403, `${response.status} ${code ?? ''}`);
} catch (error) {
  record('CSRF origen ajeno', false, error instanceof Error ? error.message : String(error));
}

// 3. Admin sin sesión no responde 200.
try {
  const { response } = await fetchText('/api/admin/plans', { headers: { accept: 'application/json' } });
  record('admin sin sesión rechazado', response.status === 401 || response.status === 503, String(response.status));
} catch (error) {
  record('admin sin sesión', false, error instanceof Error ? error.message : String(error));
}

// 4. Upload sin sesión rechazado antes de tocar storage.
try {
  const { response } = await fetchText('/api/merchant/stores/00000000-0000-0000-0000-000000000000/media', {
    method: 'POST',
  });
  record('upload sin sesión → 401', response.status === 401, String(response.status));
} catch (error) {
  record('upload sin sesión', false, error instanceof Error ? error.message : String(error));
}

// 5. Rate limit de credenciales (15/min). Después de este bloque, el login
//    queda limitado durante un minuto para esta IP: es el objetivo.
try {
  let limitedAt = null;
  for (let index = 1; index <= 18; index += 1) {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        email: `rate-limit-${Date.now()}@example.invalid`,
        password: 'not-the-password',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      limitedAt = index;
      break;
    }
  }
  record('rate limit de login', limitedAt !== null, limitedAt ? `429 en intento ${limitedAt}` : 'nunca 429');
} catch (error) {
  record('rate limit de login', false, error instanceof Error ? error.message : String(error));
}

// 6. Carga ligera (opcional).
if (loadCount > 0) {
  const paths = ['/', '/hilos-y-estilo', '/cart'];
  const times = [];
  let errors = 0;

  const workers = Array.from({ length: Math.min(5, loadCount) }, async (_, worker) => {
    for (let index = worker; index < loadCount; index += 5) {
      const path = paths[index % paths.length];
      const started = Date.now();
      try {
        const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) errors += 1;
        await response.arrayBuffer();
        times.push(Date.now() - started);
      } catch {
        errors += 1;
        times.push(Date.now() - started);
      }
    }
  });
  await Promise.all(workers);

  times.sort((a, b) => a - b);
  const p = (percentile) => times[Math.min(times.length - 1, Math.floor(times.length * percentile))];
  record(
    `carga ${loadCount} requests`,
    errors === 0,
    `p50=${p(0.5)}ms p95=${p(0.95)}ms errores=${errors}`,
  );
}

const failed = results.filter((result) => !result.ok);
console.info(
  JSON.stringify(
    { ok: failed.length === 0, base, checks: results.length, failed: failed.map((r) => r.name) },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
