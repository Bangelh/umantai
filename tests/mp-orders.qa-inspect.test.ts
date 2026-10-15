// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { GET as inspectRoute } from '../app/api/admin/qa/mp-orders/[orderId]/route';
import { maskEmail, sanitizeMpOrdersConfigOnline } from '../lib/mercadopago-orders.server';

/**
 * Herramienta QA de inspección de una Order de Mercado Pago Orders — candados,
 * sanitización y AUSENCIA de efectos secundarios.
 *
 * ⚠️ No hay red ni base de datos: `fetch` global se mockea y la ruta se invoca
 * directamente, igual que el resto de las suites de este proyecto.
 *
 * Lo que se fija acá:
 *   · Producción → 404 (la ruta no existe ahí) y NUNCA se llama a Mercado Pago.
 *   · Sin token admin → 401; sin `ADMIN_API_SECRET` → 503 (falla cerrado).
 *   · Sin `MP_ORDERS_ACCESS_TOKEN` → 503, sin tocar la API.
 *   · `orderId` inválido → 400, sin tocar la API.
 *   · Credenciales por query/header distintos del token admin → 400.
 *   · UN solo GET, vía `fetchMpOrdersOrder()`, contra `/v1/orders/{id}`.
 *   · La respuesta NO trae el checkout_url completo, ni el email completo, ni el
 *     access token, ni el webhook secret.
 *   · La ruta es SOLO LECTURA: no importa nada de comercio/base y no escribe nada.
 */

const ADMIN_SECRET = 'test-admin-secret-0123456789';
const ACCESS_TOKEN = 'TEST-mp-orders-inspect-token-should-never-leak';
const WEBHOOK_SECRET = 'test-dummy-mp-orders-webhook-secret-must-not-leak';
const QA_PAYER_EMAIL = 'comprador-qa-orders@testuser.com';
const MASKED_EMAIL = 'c***@te***.com';
const ORDER_ID = 'ORDTST01M50J1MTXV3ZECHGJAF71YZ9Q';
const REQ_MP_ID = 'req_mp_orders_inspect_0001';
const CHECKOUT_URL = `https://www.mercadopago.com.pe/checkout/v1/redirect?order_id=${ORDER_ID}`;
const ROUTE_BASE = 'https://preview.umantai.test/api/admin/qa/mp-orders';

type EnvMap = Record<string, string | undefined>;

async function withEnv<T>(env: EnvMap, fn: () => Promise<T> | T): Promise<T> {
  const saved: EnvMap = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[] = [];

async function withFetchMock<T>(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const original = globalThis.fetch;
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Variables del entorno: Preview NO productivo con todo lo necesario configurado. */
const BASE_ENV: EnvMap = {
  MP_ORDERS_ACCESS_TOKEN: ACCESS_TOKEN,
  MP_ORDERS_WEBHOOK_SECRET: WEBHOOK_SECRET,
  MP_ORDERS_BACK_URL_BASE: 'https://preview.umantai.test',
  ADMIN_API_SECRET: ADMIN_SECRET,
  APP_ENV: undefined,
  VERCEL_ENV: 'preview',
  NODE_ENV: 'test',
};

/** Respuesta de `GET /v1/orders/{id}` tal como la documenta Mercado Pago. */
function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    type: 'online',
    processing_mode: 'manual',
    status: 'processed',
    status_detail: 'accredited',
    external_reference: 'UMANTAI-MP-ORDERS-QA-fixture',
    total_amount: '1.00',
    total_paid_amount: '1.00',
    created_date: '2026-10-15T12:00:00.000Z',
    last_updated_date: '2026-10-15T12:05:00.000Z',
    expiration_time: '2026-10-16T12:00:00.000Z',
    country_code: 'PE',
    currency: 'PEN',
    live_mode: false,
    user_id: '3228895377',
    integration_data: { application_id: '8511029186095338' },
    checkout_url: CHECKOUT_URL,
    config: {
      online: {
        success_url: 'https://preview.umantai.test/?mp_orders=success',
        failure_url: 'https://preview.umantai.test/?mp_orders=failure',
        pending_url: 'https://preview.umantai.test/?mp_orders=pending',
        auto_return: 'approved',
      },
    },
    payer: { id: '1234567890', email: QA_PAYER_EMAIL },
    transactions: {
      payments: [
        { id: 'PAY01', status: 'processed', status_detail: 'accredited', amount: '1.00' },
      ],
    },
    ...overrides,
  };
}

function inspectRequest(
  orderId: string,
  options: { adminToken?: string | null; query?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const url = `${ROUTE_BASE}/${orderId}${options.query ? `?${options.query}` : ''}`;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const adminToken = options.adminToken === undefined ? ADMIN_SECRET : options.adminToken;
  if (adminToken !== null) headers['x-admin-token'] = adminToken;
  return new NextRequest(url, { headers });
}

function routeParams(orderId: string) {
  return { params: Promise.resolve({ orderId }) };
}

/** Invoca la ruta con el entorno dado y captura la respuesta en texto + JSON. */
async function inspectWithEnv(
  orderId: string,
  env: EnvMap = BASE_ENV,
  options: Parameters<typeof inspectRequest>[1] = {},
  handler: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    jsonResponse(orderPayload(), 200, { 'x-request-id': REQ_MP_ID }),
): Promise<{ status: number; payload: Record<string, unknown>; text: string }> {
  return withEnv(env, async () =>
    withFetchMock(handler, async () => {
      const response = await inspectRoute(inspectRequest(orderId, options), routeParams(orderId));
      const payload = (await response.json()) as Record<string, unknown>;
      return { status: response.status, payload, text: JSON.stringify(payload) };
    }),
  );
}

async function withCapturedConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const originalError = console.error;
  const originalInfo = console.info;
  const logs: string[] = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? ''))).join(' '));
  };
  console.error = capture;
  console.info = capture;
  try {
    return { result: await fn(), logs };
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
}

// =============================================================================
//  1. CANDADOS: entorno, autenticación administrativa y configuración
// =============================================================================

test('Producción → 404 y NUNCA llama a Mercado Pago', async () => {
  const result = await inspectWithEnv(ORDER_ID, { ...BASE_ENV, VERCEL_ENV: 'production' });
  assert.equal(result.status, 404);
  assert.equal(result.payload.code, 'qa_mp_orders_unavailable');
  assert.equal(fetchCalls.length, 0, 'en Producción no se consulta la Order');
});

test('APP_ENV=production gana sobre VERCEL_ENV=preview → 404', async () => {
  const result = await inspectWithEnv(ORDER_ID, { ...BASE_ENV, APP_ENV: 'production' });
  assert.equal(result.status, 404);
  assert.equal(fetchCalls.length, 0);
});

test('sin token admin → 401 y no consulta la Order', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, { adminToken: null });
  assert.equal(result.status, 401);
  assert.equal(result.payload.code, 'admin_unauthorized');
  assert.equal(fetchCalls.length, 0);
});

test('token admin inválido → 401', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, { adminToken: 'token-equivocado' });
  assert.equal(result.status, 401);
  assert.equal(result.payload.code, 'admin_unauthorized');
  assert.equal(fetchCalls.length, 0);
});

test('sin ADMIN_API_SECRET configurado → 503 (falla cerrado, no abierto)', async () => {
  const result = await inspectWithEnv(ORDER_ID, { ...BASE_ENV, ADMIN_API_SECRET: undefined });
  assert.equal(result.status, 503);
  assert.equal(result.payload.code, 'admin_not_configured');
  assert.equal(fetchCalls.length, 0);
});

test('sin MP_ORDERS_ACCESS_TOKEN → 503 y no llama a MP', async () => {
  const result = await inspectWithEnv(ORDER_ID, {
    ...BASE_ENV,
    MP_ORDERS_ACCESS_TOKEN: undefined,
  });
  assert.equal(result.status, 503);
  assert.equal(result.payload.code, 'mp_orders_not_configured');
  assert.equal(fetchCalls.length, 0);
});

// =============================================================================
//  2. ENTRADA: id y credenciales por canales no permitidos
// =============================================================================

test('orderId inválido → 400 sin llamar a MP', async () => {
  const invalidos = ['x', 'ORD 12345678', 'ORD/../1234', 'ORD.12345678', 'ORD#' + 'a'.repeat(70)];
  for (const orderId of invalidos) {
    const result = await inspectWithEnv(orderId, BASE_ENV);
    assert.equal(result.status, 400, `id rechazado: ${orderId}`);
    assert.equal(result.payload.code, 'invalid_order_id');
  }
  assert.equal(fetchCalls.length, 0, 'ningún id inválido llega a la API');
});

test('no acepta credenciales por header distinto del token admin → 400', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, {
    headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, 'credentials_not_allowed');
  assert.equal(fetchCalls.length, 0);
});

test('no acepta credenciales por query → 400', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, { query: 'access_token=robo' });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, 'credentials_not_allowed');
  assert.equal(fetchCalls.length, 0);
});

// =============================================================================
//  3. CAMINO FELIZ: UN GET, vía el helper del webhook, respuesta sanitizada
// =============================================================================

test('Order válida → 200 con la vista sanitizada completa', async () => {
  const result = await inspectWithEnv(ORDER_ID);

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    ok: true,
    source: 'mercadopago-orders',
    httpStatus: 200,
    mpRequestId: REQ_MP_ID,
    id: ORDER_ID,
    type: 'online',
    status: 'processed',
    statusDetail: 'accredited',
    externalReference: 'UMANTAI-MP-ORDERS-QA-fixture',
    totalAmount: '1.00',
    totalPaidAmount: '1.00',
    createdDate: '2026-10-15T12:00:00.000Z',
    lastUpdatedDate: '2026-10-15T12:05:00.000Z',
    expirationTime: '2026-10-16T12:00:00.000Z',
    processingMode: 'manual',
    countryCode: 'PE',
    currency: 'PEN',
    userId: '3228895377',
    liveMode: false,
    applicationId: '8511029186095338',
    modeFlags: { live_mode: false },
    checkoutUrlExists: true,
    checkoutUrlHost: 'www.mercadopago.com.pe',
    configOnline: {
      success_url: 'preview.umantai.test',
      failure_url: 'preview.umantai.test',
      pending_url: 'preview.umantai.test',
      auto_return: 'approved',
    },
    payer: { id: '1234567890', emailMasked: MASKED_EMAIL },
    payments: [
      { id: 'PAY01', status: 'processed', statusDetail: 'accredited', amount: '1.00' },
    ],
    errors: null,
  });
});

test('se reutiliza fetchMpOrdersOrder(): UNA sola llamada GET /v1/orders/{id} con nuestro token', async () => {
  await inspectWithEnv(ORDER_ID);

  assert.equal(fetchCalls.length, 1, 'una única petición');
  assert.equal(fetchCalls[0].url, `https://api.mercadopago.com/v1/orders/${ORDER_ID}`);
  assert.equal(fetchCalls[0].init.method, 'GET');
  const headers = new Headers(fetchCalls[0].init.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${ACCESS_TOKEN}`);

  // Y el código de la ruta llama al helper compartido, no a un fetch propio.
  const source = readSource('app/api/admin/qa/mp-orders/[orderId]/route.ts');
  assert.ok(/from\s+['"]@\/lib\/mercadopago-orders\.server['"]/.test(source));
  assert.ok(/\bfetchMpOrdersOrder\(/.test(source));
  assert.ok(!/\bfetch\(/.test(source), 'la ruta no llama a fetch por su cuenta');
});

test('el checkout_url COMPLETO y el email COMPLETO nunca aparecen en la respuesta', async () => {
  const result = await inspectWithEnv(ORDER_ID);

  assert.ok(result.payload.checkoutUrlExists === true, 'se informa que existe');
  assert.ok(!result.text.includes(CHECKOUT_URL), 'no viaja la URL completa');
  assert.ok(!result.text.includes('/checkout/v1/redirect'), 'no viaja la ruta del checkout');
  assert.ok(!result.text.includes('order_id=' + ORDER_ID), 'no viajan los parámetros');
  assert.ok(!result.text.includes(QA_PAYER_EMAIL), 'no viaja el email completo');
  assert.equal((result.payload.payer as Record<string, unknown>).emailMasked, MASKED_EMAIL);
});

test('ni el access token ni el webhook secret aparecen en la respuesta o en los logs', async () => {
  const { result, logs } = await withCapturedConsole(() => inspectWithEnv(ORDER_ID));

  assert.equal(result.status, 200);
  for (const dump of [result.text, logs.join(' ')]) {
    assert.ok(!dump.includes(ACCESS_TOKEN), 'no se filtra el access token');
    assert.ok(!dump.includes(WEBHOOK_SECRET), 'no se filtra el webhook secret');
    assert.ok(!dump.includes(QA_PAYER_EMAIL), 'no se filtra el email del comprador');
    assert.ok(!/bearer|authorization/i.test(dump), 'no se filtran cabeceras');
  }
  // El log de la inspección deja constancia de la lectura, sin datos sensibles.
  assert.ok(logs.some((line) => line.includes('[qa-mp-orders] inspected')));
});

test('email enmascarado: conserva solo lo mínimo y aguanta entradas raras', () => {
  assert.equal(maskEmail(QA_PAYER_EMAIL), MASKED_EMAIL);
  assert.equal(maskEmail('test@testuser.com'), 't***@te***.com');
  assert.equal(maskEmail('a@b.co'), 'a***@b***.co');
  assert.equal(maskEmail('sin-arroba'), '***');
  assert.equal(maskEmail('@dominio.com'), '***');
  assert.equal(maskEmail('usuario@'), '***');
  assert.equal(maskEmail(''), null);
  assert.equal(maskEmail(null), null);
});

test('config.online se reduce a hosts y flags: ninguna URL completa', () => {
  const safe = sanitizeMpOrdersConfigOnline({
    online: {
      success_url: 'https://preview.umantai.test/?mp_orders=success',
      auto_return: 'approved',
      sandboxed: true,
      // Un valor suelto con olor a credencial se descarta ENTERO.
      fallback: 'APP_USR-1234567890123456789012',
    },
  });

  assert.deepEqual(safe, {
    success_url: 'preview.umantai.test',
    auto_return: 'approved',
    sandboxed: true,
  });
});

test('config.online: una URL con credenciales en el query deja SOLO el host', () => {
  const safe = sanitizeMpOrdersConfigOnline({
    online: {
      redirect_url: `https://user:pass@preview.umantai.test/x?access_token=${ACCESS_TOKEN}`,
    },
  });

  assert.deepEqual(safe, { redirect_url: 'preview.umantai.test' });
  const text = JSON.stringify(safe);
  assert.ok(!text.includes(ACCESS_TOKEN), 'no viaja el token del query');
  assert.ok(!text.includes('user:pass'), 'no viajan credenciales embebidas en la URL');
});

test('config.online ausente o vacío no inventa datos', () => {
  assert.equal(sanitizeMpOrdersConfigOnline(undefined), null);
  assert.equal(sanitizeMpOrdersConfigOnline(null), null);
  assert.equal(sanitizeMpOrdersConfigOnline({}), null);
  assert.equal(sanitizeMpOrdersConfigOnline({ online: {} }), null);
});

// =============================================================================
//  4. LECTURAS DEGRADADAS: Order sin checkout_url, orden live y rechazo de MP
// =============================================================================

test('Order sin checkout_url → checkoutUrlExists false y host null', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, {}, () =>
    jsonResponse(orderPayload({ checkout_url: undefined }), 200),
  );

  assert.equal(result.status, 200);
  assert.equal(result.payload.checkoutUrlExists, false);
  assert.equal(result.payload.checkoutUrlHost, null);
});

test('orden LIVE (live_mode true) se reporta como tal', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, {}, () =>
    jsonResponse(orderPayload({ live_mode: true, sandbox: false }), 200),
  );

  assert.equal(result.payload.liveMode, true);
  assert.deepEqual(result.payload.modeFlags, { live_mode: true, sandbox: false });
});

test('Order sin pagos → lista vacía y sin estado de pago', async () => {
  const result = await inspectWithEnv(ORDER_ID, BASE_ENV, {}, () =>
    jsonResponse(orderPayload({ transactions: {} }), 200),
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.payments, []);
});

test('MP rechaza la lectura → 502 con su HTTP status y su código, ya sanitizados', async () => {
  const { result, logs } = await withCapturedConsole(() =>
    inspectWithEnv(ORDER_ID, BASE_ENV, {}, () =>
      jsonResponse(
        { code: 'order_not_found', message: `no existe ${ACCESS_TOKEN}` },
        404,
        { 'x-request-id': REQ_MP_ID },
      ),
    ),
  );

  assert.equal(result.status, 502);
  const errors = result.payload.errors as Record<string, unknown>;
  assert.equal(result.payload.httpStatus, 404);
  assert.equal(errors.code, 'order_not_found');
  assert.equal(errors.mpRequestId, REQ_MP_ID);
  assert.ok(!result.text.includes(ACCESS_TOKEN), 'el token se descarta en la redacción');
  assert.ok(!logs.join(' ').includes(ACCESS_TOKEN));
});

test('fallo inesperado al leer (transporte) → 500 sin filtrar nada', async () => {
  const result = await withEnv(BASE_ENV, async () =>
    withFetchMock(
      () => {
        throw new Error('conexión cortada');
      },
      async () => {
        const response = await inspectRoute(inspectRequest(ORDER_ID), routeParams(ORDER_ID));
        return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
      },
    ),
  );

  assert.equal(result.status, 500);
  assert.equal(result.payload.code, 'mp_orders_unexpected_error');
});

// =============================================================================
//  5. SIN EFECTOS SECUNDARIOS (estructural)
// =============================================================================

const ROUTE_SOURCE_PATH = 'app/api/admin/qa/mp-orders/[orderId]/route.ts';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('la ruta es SOLO LECTURA: no toca base de datos, pedidos ni inventario', () => {
  const source = readSource(ROUTE_SOURCE_PATH);
  const lower = source.toLowerCase();

  // Los comentarios documentan lo que NO se toca: se mira el código sin comentarios.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const forbiddenImports = [
    /from\s+['"][^'"]*commerce['"]/i,
    /from\s+['"][^'"]*supabase['"]/i,
    /from\s+['"][^'"]*resend['"]/i,
    /from\s+['"][^'"]*inventory['"]/i,
    /from\s+['"][^'"]*pickup['"]/i,
    /from\s+['"][^'"]*notifications['"]/i,
    /from\s+['"][^'"]*\/db['"]/i,
  ];
  for (const pattern of forbiddenImports) {
    assert.ok(!pattern.test(code), `importa un módulo prohibido: ${pattern}`);
  }

  for (const token of ['insert into', 'update ', 'delete from', 'create order', 'applyapprovedpayment(']) {
    assert.ok(!lower.replace(/\/\*[\s\S]*?\*\//g, '').includes(token), `ejecuta ${token}`);
  }

  // Solo se exporta GET: no hay forma de escribir a través de esta ruta.
  const exported = code.match(/export\s+async\s+function\s+([A-Z]+)/g) ?? [];
  assert.deepEqual(exported, ['export async function GET']);

  // Y no lee el cuerpo de la petición ni escribe archivos.
  assert.ok(!/request\.(json|text)\(/.test(code), 'GET no lee body');
  assert.ok(!/from\s+['"](node:)?fs['"]/.test(code), 'no escribe archivos');
});
