// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { POST as createOrderRoute } from '../app/api/mp-orders/create/route';
import { POST as webhookRoute } from '../app/api/mp-orders/webhook/route';
import { GET as debugRoute } from '../app/api/mp-orders/debug/route';
import {
  DEFAULT_QA_PAYER_EMAIL,
  buildMpOrdersCreateBody,
  parseAmountToCents,
  resolveMpOrdersBackUrls,
} from '../lib/mercadopago-orders.server';

/**
 * Integración CLEAN-ROOM de Mercado Pago Orders — tests de AISLAMIENTO y CONTRATO.
 *
 * Fija las 25 garantías pedidas: fail-closed sin variables nuevas, no reutilización
 * del flujo legacy, contrato de la orden (`type`/`processing_mode`/`total_amount`),
 * validación de firma con el SDK oficial, y aislamiento estructural (los archivos
 * nuevos no importan la integración vieja ni leen sus variables).
 *
 * No hay red ni base de datos: `fetch` global se mockea y las rutas se invocan
 * directamente, igual que el resto de las suites de este proyecto.
 */

const FIXTURE_SECRET = 'test-dummy-mp-orders-webhook-secret';
const LEGACY_TOKEN = 'legacy-access-token-must-not-be-used';
const LEGACY_SECRET = 'legacy-webhook-secret-must-not-be-used';
const ACCESS_TOKEN = 'TEST-mp-orders-cleanroom-token-should-never-leak';
const ADMIN_SECRET = 'test-admin-secret-0123456789';
const ORDER_ID = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
const REQUEST_ID = '2066ca19-c6f1-498a-be75-1923005edd06';
const TS = '1742505638683';
const CHECKOUT_URL = `https://www.mercadopago.com.pe/checkout/v1/redirect?order_id=${ORDER_ID}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function orderPayload() {
  return {
    id: ORDER_ID,
    type: 'online',
    processing_mode: 'manual',
    status: 'processed',
    status_detail: 'accredited',
    external_reference: 'UMANTAI-MP-ORDERS-QA-fixture',
    total_amount: '1.00',
    total_paid_amount: '1.00',
    user_id: '3228895377',
    integration_data: { application_id: '8511029186095338' },
    payer: { email: DEFAULT_QA_PAYER_EMAIL },
    transactions: { payments: [{ id: 'PAY01', status: 'processed', status_detail: 'accredited' }] },
  };
}

function createdOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    status: 'created',
    checkout_url: CHECKOUT_URL,
    external_reference: 'UMANTAI-MP-ORDERS-QA-fixture',
    total_amount: '1.00',
    ...overrides,
  };
}

function manifest(dataId: string, requestId: string, ts: string): string {
  return `id:${dataId};request-id:${requestId};ts:${ts};`;
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function signatureHeader(hash: string, ts: string = TS): string {
  return `ts=${ts},v1=${hash}`;
}

function validSignature(dataId: string = ORDER_ID, secret: string = FIXTURE_SECRET): string {
  return signatureHeader(sign(manifest(dataId, REQUEST_ID, TS), secret));
}

function webhookRequest(
  options: {
    dataId?: string | null;
    xRequestId?: string | null;
    xSignature?: string | null;
    type?: string | null;
  } = {},
): Request {
  const params = new URLSearchParams();
  const dataId = options.dataId === undefined ? ORDER_ID : options.dataId;
  if (dataId !== null) params.set('data.id', dataId);
  const type = options.type === undefined ? 'order' : options.type;
  if (type !== null) params.set('type', type);

  const headers = new Headers();
  const xRequestId = options.xRequestId === undefined ? REQUEST_ID : options.xRequestId;
  if (xRequestId !== null) headers.set('x-request-id', xRequestId);
  const xSignature = options.xSignature === undefined ? validSignature() : options.xSignature;
  if (xSignature !== null) headers.set('x-signature', xSignature);
  headers.set('user-agent', 'mp-orders-test-agent/1.0');

  return new Request(`https://preview.umantai.test/api/mp-orders/webhook?${params.toString()}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'order.processed',
      type: 'order',
      live_mode: false,
      data: { id: dataId },
    }),
  });
}

function createRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://preview.umantai.test/api/mp-orders/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function debugRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://preview.umantai.test/api/mp-orders/debug', { headers });
}

const MP_ORDERS_ENV: EnvMap = {
  MP_ORDERS_ACCESS_TOKEN: ACCESS_TOKEN,
  MP_ORDERS_WEBHOOK_SECRET: FIXTURE_SECRET,
  MP_ORDERS_BACK_URL_BASE: undefined,
  MERCADOPAGO_ACCESS_TOKEN: undefined,
  MERCADOPAGO_WEBHOOK_SECRET: undefined,
  MERCADOPAGO_BACK_URL_BASE: undefined,
  ADMIN_API_SECRET: ADMIN_SECRET,
};

// =============================================================================
//  CONFIGURACIÓN (1-3) Y DEBUG (4-5)
// =============================================================================

test('1. sin MP_ORDERS_ACCESS_TOKEN, create falla cerrado (503) y no usa el legacy', async () => {
  await withEnv(
    { ...MP_ORDERS_ENV, MP_ORDERS_ACCESS_TOKEN: undefined, MERCADOPAGO_ACCESS_TOKEN: LEGACY_TOKEN },
    async () => {
      await withFetchMock(
        () => jsonResponse({}),
        async () => {
          const res = await createOrderRoute(createRequest());
          assert.equal(res.status, 503);
          assert.equal(fetchCalls.length, 0);
        },
      );
    },
  );
});

test('2. sin MP_ORDERS_WEBHOOK_SECRET, el webhook falla cerrado (503) y no consulta nada', async () => {
  await withEnv(
    {
      ...MP_ORDERS_ENV,
      MP_ORDERS_WEBHOOK_SECRET: undefined,
      MERCADOPAGO_WEBHOOK_SECRET: LEGACY_SECRET,
    },
    async () => {
      await withFetchMock(
        () => jsonResponse(orderPayload()),
        async () => {
          const res = await webhookRoute(webhookRequest());
          assert.equal(res.status, 503);
          assert.equal(fetchCalls.length, 0);
        },
      );
    },
  );
});

test('3. con variables legacy presentes pero MP_ORDERS_* ausentes, NO se usa el legacy', async () => {
  await withEnv(
    {
      ...MP_ORDERS_ENV,
      MP_ORDERS_ACCESS_TOKEN: undefined,
      MP_ORDERS_WEBHOOK_SECRET: undefined,
      MERCADOPAGO_ACCESS_TOKEN: LEGACY_TOKEN,
      MERCADOPAGO_WEBHOOK_SECRET: LEGACY_SECRET,
    },
    async () => {
      await withFetchMock(
        () => jsonResponse(orderPayload()),
        async () => {
          const create = await createOrderRoute(createRequest());
          const hook = await webhookRoute(webhookRequest());
          assert.equal(create.status, 503);
          assert.equal(hook.status, 503);
          assert.equal(fetchCalls.length, 0);
        },
      );
    },
  );
});

test('4. Production nunca habilita el debug (ni con token admin válido)', async () => {
  await withEnv({ ...MP_ORDERS_ENV, VERCEL_ENV: 'production' }, async () => {
    const res = await debugRoute(debugRequest({ 'x-admin-token': ADMIN_SECRET }));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'debug_not_available');
  });
});

test('5. Preview + admin token válido devuelve solo booleanos seguros', async () => {
  await withEnv({ ...MP_ORDERS_ENV, VERCEL_ENV: 'preview' }, async () => {
    const unauthorized = await debugRoute(debugRequest());
    assert.equal(unauthorized.status, 401);

    const res = await debugRoute(debugRequest({ 'x-admin-token': ADMIN_SECRET }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      runtime: process.env.NEXT_RUNTIME ?? 'nodejs',
      vercelEnv: 'preview',
      accessTokenConfigured: true,
      webhookSecretConfigured: true,
      backUrlConfigured: false,
      implementation: 'orders-cleanroom',
      legacyVariablesUsed: false,
    });
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(ACCESS_TOKEN), 'el debug no filtra el access token');
    assert.ok(!raw.includes(FIXTURE_SECRET), 'el debug no filtra el webhook secret');
  });
});

// =============================================================================
//  ORDEN (6-12)
// =============================================================================

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(fetchCalls[0]?.init.body ?? '{}')) as Record<string, unknown>;
}

function sentHeaders(): Headers {
  return new Headers(fetchCalls[0]?.init.headers ?? {});
}

async function createWithMock(
  body: Record<string, unknown> = {},
): Promise<{ status: number; payload: Record<string, unknown>; text: string }> {
  let captured = { status: 0, payload: {} as Record<string, unknown>, text: '' };
  await withEnv({ ...MP_ORDERS_ENV }, async () => {
    await withFetchMock(
      () => jsonResponse(createdOrderPayload(), 201),
      async () => {
        const res = await createOrderRoute(createRequest(body));
        captured = {
          status: res.status,
          payload: (await res.json()) as Record<string, unknown>,
          text: res.status.toString(),
        };
        captured.text = JSON.stringify(captured.payload);
      },
    );
  });
  return captured;
}

test('6. create siempre envía X-Idempotency-Key (UUID) y Authorization solo hacia MP', async () => {
  const result = await createWithMock();
  assert.equal(result.status, 201);
  const key = sentHeaders().get('X-Idempotency-Key');
  assert.ok(key && UUID_PATTERN.test(key), 'X-Idempotency-Key debe ser un UUID presente');
  assert.equal(fetchCalls[0].url, 'https://api.mercadopago.com/v1/orders');
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(sentHeaders().get('Authorization'), `Bearer ${ACCESS_TOKEN}`);
});

test('7. el X-Idempotency-Key es único por cada creación', async () => {
  const first = await createWithMock();
  const firstKey = sentHeaders().get('X-Idempotency-Key');
  await createWithMock();
  const secondKey = sentHeaders().get('X-Idempotency-Key');
  assert.equal(first.status, 201);
  assert.ok(firstKey && secondKey);
  assert.notEqual(firstKey, secondKey);
});

test('8-9-10. la orden enviada cumple el contrato (online / manual / total = suma de items)', async () => {
  await createWithMock();
  const body = sentBody();
  const items = body.items as Array<{
    unit_price: string;
    quantity: number;
    total_amount: string;
    unit_measure: string;
  }>;
  assert.equal(body.type, 'online');
  assert.equal(body.processing_mode, 'manual');

  const itemsTotal = items.reduce(
    (sum, item) => sum + parseAmountToCents(item.unit_price)! * item.quantity,
    0,
  );
  assert.equal(parseAmountToCents(String(body.total_amount)), itemsTotal);
  assert.equal(String(body.total_amount), '1.00');
  assert.equal(items[0].total_amount, '1.00');
  assert.equal(items[0].unit_measure, 'unit');
  assert.deepEqual(body.payer, { email: DEFAULT_QA_PAYER_EMAIL });
  assert.equal(resolveMpOrdersBackUrls(''), null);
  assert.equal(body.config, undefined, 'sin MP_ORDERS_BACK_URL_BASE no se inventa config');

  // Aritmética en centavos (sin floats) con varios ítems.
  const multi = buildMpOrdersCreateBody({
    externalReference: 'UMANTAI-MP-ORDERS-QA-multi',
    payerEmail: DEFAULT_QA_PAYER_EMAIL,
    items: [
      { title: 'A', unitPrice: '19.90', quantity: 3 },
      { title: 'B', unitPrice: '0.30', quantity: 1 },
    ],
  });
  assert.equal(multi.total_amount, '60.00');
  assert.deepEqual(
    multi.items.map((item) => item.total_amount),
    ['59.70', '0.30'],
  );
});

test('11-12. la respuesta expone checkoutUrl y NUNCA el token', async () => {
  const result = await createWithMock();
  assert.equal(result.payload.checkoutUrl, CHECKOUT_URL);
  assert.equal(result.payload.orderId, ORDER_ID);
  assert.ok(!result.text.includes(ACCESS_TOKEN), 'no debe filtrarse el access token');
  assert.ok(!result.text.toLowerCase().includes('bearer'), 'no debe filtrarse Authorization');
  assert.deepEqual(Object.keys(result.payload).sort(), [
    'checkoutUrl',
    'externalReference',
    'orderId',
    'status',
    'totalAmount',
  ]);
});

// =============================================================================
//  WEBHOOK (13-22)
// =============================================================================

async function webhookWithMock(
  request: Request,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  let captured = { status: 0, payload: {} as Record<string, unknown> };
  await withEnv({ ...MP_ORDERS_ENV }, async () => {
    await withFetchMock(
      () => jsonResponse(orderPayload()),
      async () => {
        const res = await webhookRoute(request);
        captured = { status: res.status, payload: (await res.json()) as Record<string, unknown> };
      },
    );
  });
  return captured;
}

test('13. sin x-signature → rechazo (401)', async () => {
  const result = await webhookWithMock(webhookRequest({ xSignature: null }));
  assert.equal(result.status, 401);
  assert.deepEqual(result.payload.missing, ['x-signature']);
  assert.equal(fetchCalls.length, 0);
});

test('14. sin x-request-id → rechazo (401)', async () => {
  const result = await webhookWithMock(webhookRequest({ xRequestId: null }));
  assert.equal(result.status, 401);
  assert.deepEqual(result.payload.missing, ['x-request-id']);
  assert.equal(fetchCalls.length, 0);
});

test('15. sin el data.id requerido → rechazo (401)', async () => {
  const result = await webhookWithMock(webhookRequest({ dataId: null }));
  assert.equal(result.status, 401);
  assert.deepEqual(result.payload.missing, ['data.id']);
  assert.equal(fetchCalls.length, 0);
});

test('16. firma inválida → 401 con motivo SignatureMismatch', async () => {
  const result = await webhookWithMock(
    webhookRequest({ xSignature: validSignature(ORDER_ID, 'otro-secreto-distinto') }),
  );
  assert.equal(result.status, 401);
  assert.equal(result.payload.reason, 'SignatureMismatch');
  assert.equal(fetchCalls.length, 0);
});

test('17. fixture de firma válida (SDK oficial) → 200', async () => {
  const result = await webhookWithMock(webhookRequest());
  assert.equal(result.status, 200);
  assert.equal(result.payload.orderId, ORDER_ID);
});

test('18. el secret de los fixtures es dummy y no viene de process.env', () => {
  assert.ok(FIXTURE_SECRET.startsWith('test-dummy-'));
  assert.notEqual(FIXTURE_SECRET, LEGACY_SECRET);
  assert.equal(process.env.MP_ORDERS_WEBHOOK_SECRET, undefined);
  assert.equal(process.env.MERCADOPAGO_WEBHOOK_SECRET, undefined);
});

test('19. NO se usa el webhook secret legacy para validar', async () => {
  const result = await withEnv(
    { ...MP_ORDERS_ENV, MERCADOPAGO_WEBHOOK_SECRET: LEGACY_SECRET },
    async () => {
      let captured = 0;
      await withFetchMock(
        () => jsonResponse(orderPayload()),
        async () => {
          const res = await webhookRoute(
            webhookRequest({ xSignature: validSignature(ORDER_ID, LEGACY_SECRET) }),
          );
          captured = res.status;
        },
      );
      return captured;
    },
  );
  assert.equal(result, 401);
  assert.equal(fetchCalls.length, 0);
});

test('21. un webhook válido consulta la Order correcta con nuestro token', async () => {
  const result = await webhookWithMock(webhookRequest());
  assert.equal(result.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, `https://api.mercadopago.com/v1/orders/${ORDER_ID}`);
  assert.equal(fetchCalls[0].init.method, 'GET');
  assert.equal(sentHeaders().get('Authorization'), `Bearer ${ACCESS_TOKEN}`);
  assert.ok(!JSON.stringify(result.payload).includes(ACCESS_TOKEN));
});

test('22. un webhook inválido NO consulta la Order', async () => {
  const result = await webhookWithMock(
    webhookRequest({ xSignature: validSignature(ORDER_ID, 'secreto-forjado') }),
  );
  assert.equal(result.status, 401);
  assert.equal(fetchCalls.length, 0);
});

// =============================================================================
//  AISLAMIENTO ESTRUCTURAL (20, 23-25)
// =============================================================================

const NEW_FILES = [
  'lib/mercadopago-orders.server.ts',
  'app/api/mp-orders/create/route.ts',
  'app/api/mp-orders/webhook/route.ts',
  'app/api/mp-orders/debug/route.ts',
];

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('20. los archivos nuevos no tocan orders/inventory/pickup ni notifican correos', () => {
  // Se mira el CÓDIGO (imports y llamadas), no los comentarios: los archivos
  // documentan explícitamente qué tablas NO tocan.
  const forbiddenImports = [
    /from\s+['"][^'"]*commerce['"]/i,
    /from\s+['"][^'"]*supabase['"]/i,
    /from\s+['"][^'"]*resend['"]/i,
    /from\s+['"][^'"]*inventory['"]/i,
    /from\s+['"][^'"]*pickup['"]/i,
  ];
  const forbiddenCode = [
    'confirmOrderPayment(',
    'notifyNewOrderSafely(',
    'recordPaymentWebhookEvent(',
    'reserveStock(',
    'insert into',
    'delete from',
  ];

  for (const file of NEW_FILES) {
    const source = readSource(file);
    for (const pattern of forbiddenImports) {
      assert.ok(!pattern.test(source), `${file} importa un módulo prohibido (${pattern})`);
    }
    const lower = source.toLowerCase();
    for (const token of forbiddenCode) {
      assert.ok(!lower.includes(token), `${file} usa ${token}`);
    }
  }
});

test('23. ningún archivo nuevo importa lib/mercadopago.server.ts', () => {
  for (const file of NEW_FILES) {
    const source = readSource(file);
    assert.ok(!/from\s+['"][^'"]*mercadopago\.server['"]/.test(source), file);
    assert.ok(!/import\(\s*['"][^'"]*mercadopago\.server['"]\s*\)/.test(source), file);
  }
});

test('24. ningún archivo nuevo lee variables legacy ni prefijos de Vercel', () => {
  const forbidden = [
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_WEBHOOK_SECRET',
    'MERCADOPAGO_BACK_URL_BASE',
    'BANGELH_',
    'UMANTAI_',
  ];
  for (const file of NEW_FILES) {
    const source = readSource(file);
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `${file} menciona ${token}`);
    }
    // `getPrefixedEnv` se prohíbe como USO (llamada) y como import del helper legacy.
    assert.ok(!/getPrefixedEnv\s*\(/.test(source), `${file} usa getPrefixedEnv`);
    assert.ok(!/from\s+['"][^'"]*\/env['"]/.test(source), `${file} importa el helper de env legacy`);
  }
});

test('25. los archivos nuevos solo leen MP_ORDERS_* para Mercado Pago', () => {
  const envReadPattern =
    /(?:process\.env\.([A-Z0-9_]+))|(?:process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\])|(?:readExactEnv\(\s*['"]([A-Z0-9_]+)['"]\s*\))/g;
  const allowedNonMpOrders = new Set(['VERCEL_ENV', 'NEXT_RUNTIME']);
  const mpOrdersNames = new Set<string>();

  for (const file of NEW_FILES) {
    for (const match of readSource(file).matchAll(envReadPattern)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!name) continue;
      assert.ok(!name.startsWith('MERCADOPAGO'), `${file} lee la variable legacy ${name}`);
      if (name.startsWith('MP_')) mpOrdersNames.add(name);
      else assert.ok(allowedNonMpOrders.has(name), `${file} lee una variable inesperada: ${name}`);
    }
  }

  assert.deepEqual([...mpOrdersNames].sort(), [
    'MP_ORDERS_ACCESS_TOKEN',
    'MP_ORDERS_BACK_URL_BASE',
    'MP_ORDERS_WEBHOOK_SECRET',
  ]);
});
