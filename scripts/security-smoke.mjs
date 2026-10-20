#!/usr/bin/env node
/**
 * scripts/security-smoke.mjs — suite de hardening contra un entorno YA
 * desplegado (staging por defecto). No requiere credenciales ni modifica datos
 * reales: crea, como mucho, intentos fallidos de login.
 *
 * Uso:
 *   node scripts/security-smoke.mjs
 *   SMOKE_BASE_URL=https://... node scripts/security-smoke.mjs
 *   node scripts/security-smoke.mjs --load 40
 *
 * Cubre: headers/CSP, CSRF, tenant tampering, IDOR, auth bypass, JSON inválido,
 * payload gigante, upload inválido, XSS en búsqueda, SQL-like, rate limit,
 * cookie de sesión falsificada y autorización de Platform Admin.
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

async function json(path, init = {}) {
  const { response, body } = await fetchText(path, init);
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  return { response, payload, body };
}

// 1. Headers de seguridad + CSP sin unsafe-inline para scripts.
try {
  const { response } = await fetchText('/');
  const headers = response.headers;
  const csp = headers.get('content-security-policy') ?? '';
  const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src')) ?? '';
  const checks = [
    ['content-security-policy', csp.includes("default-src 'self'")],
    ['csp script-src con nonce', /nonce-[A-Za-z0-9+/=]+/.test(scriptSrc)],
    ['csp script-src sin unsafe-inline', !scriptSrc.includes('unsafe-inline')],
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
  const { response, payload } = await json('/api/admin/session', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  record(
    'CSRF origen ajeno → 403',
    response.status === 403 && payload?.code === 'csrf_origin_rejected',
    `${response.status} ${payload?.code ?? ''}`,
  );
} catch (error) {
  record('CSRF origen ajeno', false, error instanceof Error ? error.message : String(error));
}

// 3. Auth bypass / Platform Admin: sin cookie y con cookie falsificada.
try {
  const { response } = await json('/api/admin/plans');
  record(
    'admin sin sesión rechazado',
    response.status === 401 || response.status === 503,
    String(response.status),
  );

  const forged = await json('/api/admin/plans', {
    headers: {
      cookie: 'umantai_platform_admin=eyJ2IjoxLCJ1IjoiZmFrZSIsImUiOjk5OTk5OTk5OTl9.firma-falsa',
    },
  });
  record(
    'Platform Admin con cookie falsificada → 401',
    forged.response.status === 401,
    String(forged.response.status),
  );
} catch (error) {
  record('admin auth', false, error instanceof Error ? error.message : String(error));
}

// 4. Tenant tampering / IDOR: IDs ajenos o inexistentes no filtran datos.
try {
  const storeId = '00000000-0000-0000-0000-000000000000';
  const productId = '00000000-0000-0000-0000-000000000001';

  const product = await json(`/api/merchant/stores/${storeId}/products/${productId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ name: 'Intruso', priceCents: 1 }),
  });
  record(
    'tenant tampering sin sesión → 401',
    product.response.status === 401,
    String(product.response.status),
  );

  const inventory = await json(`/api/merchant/stores/${storeId}/inventory`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ productSlug: 'x', quantityOnHand: 0 }),
  });
  record(
    'inventario de otra tienda sin sesión → 401',
    inventory.response.status === 401,
    String(inventory.response.status),
  );

  const orders = await json('/api/account/orders');
  record('cuenta sin sesión → 401', orders.response.status === 401, String(orders.response.status));
} catch (error) {
  record('tenant tampering', false, error instanceof Error ? error.message : String(error));
}

// 5. Upload inválido / sin sesión.
try {
  const { response } = await fetchText(
    '/api/merchant/stores/00000000-0000-0000-0000-000000000000/media',
    { method: 'POST' },
  );
  record('upload sin sesión → 401', response.status === 401, String(response.status));
} catch (error) {
  record('upload sin sesión', false, error instanceof Error ? error.message : String(error));
}

// 6. JSON malformado.
try {
  const { response } = await fetchText('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{"email":',
  });
  record(
    'JSON malformado → 4xx (no 5xx)',
    response.status >= 400 && response.status < 500,
    String(response.status),
  );
} catch (error) {
  record('JSON malformado', false, error instanceof Error ? error.message : String(error));
}

// 7. Payload sobredimensionado.
try {
  const { response } = await fetchText('/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ message: 'x'.repeat(20_000) }),
  });
  record(
    'payload 20KB rechazado',
    response.status === 413 || response.status === 400 || response.status === 429,
    String(response.status),
  );
} catch (error) {
  record('payload grande', false, error instanceof Error ? error.message : String(error));
}

// 8. XSS y SQL-like en búsqueda: nunca 5xx ni HTML ejecutable.
try {
  const xss = await json(`/api/search?q=${encodeURIComponent('<script>alert(1)</script>')}`);
  const contentType = xss.response.headers.get('content-type') ?? '';
  record(
    'XSS en búsqueda no se refleja como HTML',
    xss.response.status === 200 && contentType.includes('application/json'),
    `${xss.response.status} ${contentType}`,
  );

  const sqli = await json(`/api/search?q=${encodeURIComponent("' OR 1=1 --")}`);
  record('SQL-like en búsqueda → 200', sqli.response.status === 200, String(sqli.response.status));

  const badGeo = await json('/api/search?lat=999&lng=-77');
  record(
    'coordenadas inválidas → 400',
    badGeo.response.status === 400,
    String(badGeo.response.status),
  );
} catch (error) {
  record('búsqueda hostil', false, error instanceof Error ? error.message : String(error));
}

// 9. Rate limit de credenciales (15/min). Al final: deja esta IP limitada 1 min.
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

// 10. Carga ligera opcional (señal, no benchmark).
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
