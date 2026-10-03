// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type { OrderWithItems } from '../lib/commerce';
import {
  buildCheckoutPreferenceBody,
  createCheckoutPreference,
  matchesNotificationRouting,
  readStoredCheckoutPreference,
  toStoredPreferenceSnapshot,
  type StoredCheckoutPreference,
} from '../lib/mercadopago.server';
import {
  MP_DIAGNOSTIC_HEADER,
  MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL,
  POST,
  decideNotificationRouting,
  requestedNotificationUrlOmission,
} from '../app/api/payments/preference/route';

/**
 * Diagnóstico A/B de `notification_url` (SOLO Preview).
 *
 * Garantías que fija esta suite:
 *   A. El flujo normal SIGUE enviando `notification_url` (sin cambios).
 *   B. El modo diagnóstico autorizado (Preview + token admin) NO la envía y audita
 *      `notificationUrl: null` + `notificationSource: "dashboard"`.
 *   C. Fuera de Preview no puede activarse (403), ni con token admin.
 *   D. En Preview, sin auth admin (o con token inválido) no puede activarse (401).
 *   E. El modo no cambia external_reference, items, total, back_urls, sandbox ni la
 *      idempotencia/reuso.
 *
 * No se llama a Mercado Pago: el `fetch` global del SDK se mockea.
 */

const ORIGIN = 'https://umantai-git-feat-ecommerce-core-umantai.vercel.app';
const ADMIN_SECRET = 'test-admin-secret-0123456789';
const MP_TOKEN = 'TEST-1234567890-abcdefabcdef-3228895377-abcdefabcdef';

type Env = Record<string, string | undefined>;

async function withEnv<T>(env: Env, fn: () => Promise<T> | T): Promise<T> {
  const saved: Env = {};
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

function sampleOrder(): OrderWithItems {
  return {
    id: '1bee1e56-2eb0-4cc6-ae25-5cac7f47666f',
    orderNumber: 'UM-2026-001011',
    publicToken: '9dffe128-0f81-4fa5-9f77-1eeafaef8129',
    currency: 'PEN',
    total: 749,
    shippingTotal: 0,
    contactEmail: 'qa.mp.sandbox@example.com',
    contactPhone: null,
    metadata: {},
    items: [
      {
        id: '086a71e6-42c7-4026-8847-7250a4ce9d71',
        orderId: '1bee1e56-2eb0-4cc6-ae25-5cac7f47666f',
        lineNumber: 1,
        productSlug: 'dyson-v15-detect',
        productName: 'Dyson V15 Detect Absolute',
        productBrand: 'Dyson',
        imageUrl: null,
        variantKey: '',
        variant: {},
        quantity: 1,
        unitPrice: 749,
        discountAmount: 0,
        taxAmount: 0,
        lineTotal: 749,
      },
    ],
  } as unknown as OrderWithItems;
}

interface CapturedRequest {
  url: string;
  method?: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** `fetch` mock que captura el body EXACTO que se manda a `/checkout/preferences/`. */
function mockPreferenceFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    captured.push({
      url,
      method: init?.method,
      body: JSON.parse(rawBody) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Response.json(
      {
        id: '3228895377-test-preference',
        init_point: 'https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=test',
        sandbox_init_point: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=test',
      },
      { status: 200 },
    );
  }) as typeof fetch;
}

/** Ejecuta `createCheckoutPreference` con red mockeada y devuelve lo capturado. */
async function runCreate(
  omitNotificationUrl: boolean,
  env: Env = {},
): Promise<{ pref: StoredCheckoutPreference; captured: CapturedRequest[]; order: OrderWithItems }> {
  const captured: CapturedRequest[] = [];
  const order = sampleOrder();
  const pref = await withEnv({ MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN, ...env }, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockPreferenceFetch(captured);
    try {
      return await createCheckoutPreference(order, {
        origin: ORIGIN,
        idempotencyKey: 'preference-test',
        omitNotificationUrl,
      });
    } finally {
      globalThis.fetch = original;
    }
  });
  return { pref, captured, order };
}

// =============================================================================
//  A. Flujo normal: sigue enviando notification_url
// =============================================================================

test('A. flujo normal: sigue enviando notification_url a Mercado Pago', async () => {
  const { pref, captured } = await runCreate(false);

  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/checkout\/preferences\/$/);
  assert.equal(captured[0].body.notification_url, `${ORIGIN}/api/payments/webhook`);
  assert.equal(pref.notificationUrl, `${ORIGIN}/api/payments/webhook`);
  assert.equal(pref.notificationSource, 'preference');

  const snapshot = toStoredPreferenceSnapshot(pref);
  assert.equal(snapshot.mercadoPago.notificationUrl, `${ORIGIN}/api/payments/webhook`);
  assert.equal(snapshot.mercadoPago.notificationSource, 'preference');

  // La construcción pura coincide con lo que viajó a MP.
  const pure = buildCheckoutPreferenceBody(sampleOrder(), ORIGIN);
  assert.equal(pure.body.notification_url, pure.notificationUrl);
  assert.equal(pure.notificationUrl, `${ORIGIN}/api/payments/webhook`);
  assert.equal(pure.notificationSource, 'preference');
});

// =============================================================================
//  B. Modo diagnóstico Preview autorizado: NO incluye notification_url
// =============================================================================

test('B. modo diagnóstico: NO incluye notification_url y audita null + "dashboard"', async () => {
  const { pref, captured } = await runCreate(true);

  assert.equal(captured.length, 1);
  assert.equal('notification_url' in captured[0].body, false, 'no debe viajar notification_url');
  assert.equal(pref.notificationUrl, null, 'no se inventa una URL');
  assert.equal(pref.notificationSource, 'dashboard');

  const snapshot = toStoredPreferenceSnapshot(pref);
  assert.equal(snapshot.mercadoPago.notificationUrl, null);
  assert.equal(snapshot.mercadoPago.notificationSource, 'dashboard');

  // La decisión pura exige Preview + admin para activar el modo.
  assert.deepEqual(decideNotificationRouting(true, true, { ok: true }), {
    ok: true,
    omitNotificationUrl: true,
  });

  // El header se reconoce exactamente.
  const request = new Request('https://preview.example.com/api/payments/preference', {
    method: 'POST',
    headers: { [MP_DIAGNOSTIC_HEADER]: MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL },
  });
  assert.equal(requestedNotificationUrlOmission(request), true);
});

// =============================================================================
//  C. Fuera de Preview no puede activarse
// =============================================================================

test('C. fuera de Preview no se activa (aunque haya token admin)', async () => {
  const decision = decideNotificationRouting(true, false, { ok: true });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.status, 403);
    assert.equal(decision.code, 'diagnostic_not_available');
  }

  const response = await withEnv(
    { VERCEL_ENV: 'production', MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN, ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const request = new NextRequest('https://localhost:3000/api/payments/preference', {
        method: 'POST',
        headers: {
          [MP_DIAGNOSTIC_HEADER]: MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL,
          'x-admin-token': ADMIN_SECRET,
        },
      });
      return POST(request);
    },
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, 'diagnostic_not_available');
});

// =============================================================================
//  D. Sin auth admin no puede activarse
// =============================================================================

test('D. en Preview sin token admin no se activa (401)', async () => {
  const decision = decideNotificationRouting(true, true, {
    ok: false,
    status: 401,
    code: 'admin_unauthorized',
    message: 'nope',
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.status, 401);

  const response = await withEnv(
    { VERCEL_ENV: 'preview', MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN, ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const request = new NextRequest('https://localhost:3000/api/payments/preference', {
        method: 'POST',
        headers: { [MP_DIAGNOSTIC_HEADER]: MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL },
      });
      return POST(request);
    },
  );

  assert.equal(response.status, 401);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, 'admin_unauthorized');
});

test('D2. en Preview con token admin INVÁLIDO no se activa (401)', async () => {
  const response = await withEnv(
    { VERCEL_ENV: 'preview', MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN, ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const request = new NextRequest('https://localhost:3000/api/payments/preference', {
        method: 'POST',
        headers: {
          [MP_DIAGNOSTIC_HEADER]: MP_DIAGNOSTIC_OMIT_NOTIFICATION_URL,
          'x-admin-token': 'token-equivocado',
        },
      });
      return POST(request);
    },
  );

  assert.equal(response.status, 401);
});

test('D3. un header con valor desconocido NO activa el modo (queda como flujo normal)', async () => {
  // Sin header reconocido, el flujo sigue normal: un body vacío da 400, nunca 403.
  const response = await withEnv(
    { VERCEL_ENV: 'preview', MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN, ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const request = new NextRequest('https://localhost:3000/api/payments/preference', {
        method: 'POST',
        headers: { [MP_DIAGNOSTIC_HEADER]: 'otro-valor' },
      });
      return POST(request);
    },
  );

  assert.equal(response.status, 400);
});

// =============================================================================
//  E. No afecta external_reference, items, total, back_urls, payer ni metadata
// =============================================================================

test('E. el modo diagnóstico no cambia el resto del body', () => {
  const order = sampleOrder();
  const normal = buildCheckoutPreferenceBody(order, ORIGIN);
  const diag = buildCheckoutPreferenceBody(order, ORIGIN, { omitNotificationUrl: true });

  assert.equal(normal.body.external_reference, 'UM-2026-001011');
  assert.equal(normal.body.external_reference, diag.body.external_reference);
  assert.deepEqual(normal.body.items, diag.body.items);
  assert.deepEqual(normal.body.back_urls, diag.body.back_urls);
  assert.deepEqual(normal.body.payer, diag.body.payer);
  assert.deepEqual(normal.body.metadata, diag.body.metadata);
  assert.equal(normal.body.auto_return, diag.body.auto_return);

  // Lo ÚNICO que cambia es la ruta de notificación.
  assert.equal(normal.body.notification_url, `${ORIGIN}/api/payments/webhook`);
  assert.equal('notification_url' in diag.body, false);
});

test('E2. sandbox e idempotencia no cambian con el modo', async () => {
  const normal = await runCreate(false, { MERCADOPAGO_SANDBOX: 'true' });
  const diag = await runCreate(true, { MERCADOPAGO_SANDBOX: 'true' });

  for (const run of [normal, diag]) {
    assert.equal(run.pref.initPoint, run.pref.sandboxInitPoint, 'sandbox=true usa sandbox_init_point');
    const idempotency = Object.entries(run.captured[0].headers).find(
      ([key]) => key.toLowerCase() === 'x-idempotency-key',
    );
    assert.equal(idempotency?.[1], 'preference-test');
  }
});

test('E3. el reuso respeta el modo: no se mezcla diagnóstico con normal', () => {
  const normalStored: StoredCheckoutPreference = {
    preferenceId: 'pref-normal',
    initPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=x',
    sandboxInitPoint: null,
    notificationUrl: `${ORIGIN}/api/payments/webhook`,
    notificationSource: 'preference',
    createdAt: new Date().toISOString(),
  };
  const diagStored: StoredCheckoutPreference = {
    preferenceId: 'pref-diag',
    initPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=y',
    sandboxInitPoint: null,
    notificationUrl: null,
    notificationSource: 'dashboard',
    createdAt: new Date().toISOString(),
  };

  // Mismo modo → se puede reutilizar (idempotencia intacta).
  assert.equal(matchesNotificationRouting(normalStored, false), true);
  assert.equal(matchesNotificationRouting(diagStored, true), true);
  // Modo distinto → NO se reutiliza (no se contamina el flujo normal).
  assert.equal(matchesNotificationRouting(diagStored, false), false);
  assert.equal(matchesNotificationRouting(normalStored, true), false);

  // Un snapshot antiguo sin `notificationSource` cuenta como flujo normal.
  const legacy = readStoredCheckoutPreference({
    metadata: {
      payment: {
        mercadoPago: {
          preferenceId: 'pref-legacy',
          initPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=z',
          notificationUrl: `${ORIGIN}/api/payments/webhook`,
          createdAt: new Date().toISOString(),
        },
      },
    },
  } as unknown as Pick<OrderWithItems, 'metadata'>);
  assert.equal(legacy?.notificationSource, 'preference');
  assert.equal(matchesNotificationRouting(legacy as StoredCheckoutPreference, false), true);
});
