import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/debug/mercadopago-identity/route';
import {
  collectMercadoPagoIdentity,
  normalizeResourceId,
  sanitizeMpPayment,
  sanitizeMpPreference,
  sanitizeMpUser,
} from '../lib/mercadopago-identity.server';

/**
 * Diagnóstico de IDENTIDAD de Mercado Pago.
 *
 * Fija las garantías de seguridad del endpoint ADMIN `/api/debug/mercadopago-identity`:
 *   · está cerrado sin token admin (401) y sin token de MP (503);
 *   · devuelve SOLO los campos permitidos (proyección por allowlist);
 *   · NUNCA filtra access token, webhook secret, cabecera Authorization, email/DNI
 *     del comprador ni datos de tarjeta;
 *   · los errores de MP quedan sanitizados.
 *
 * No se llama a Mercado Pago: `fetch` se inyecta/mockea.
 */

const ADMIN_SECRET = 'test-admin-secret-0123456789';
const MP_TOKEN = 'TEST-1234567890-abcdefabcdef-3228895377-abcdefabcdef';
const WEBHOOK_SECRET = 'clave-secreta-webhook-no-debe-filtrarse';
const PREFERENCE_ID = '3228895377-d0e3d567-8e58-47bb-b97b-f67b87678d4e';
const PAYMENT_ID = '182148824342';

type EnvKey = 'ADMIN_API_SECRET' | 'MERCADOPAGO_ACCESS_TOKEN' | 'MERCADOPAGO_WEBHOOK_SECRET';

async function withEnv<T>(env: Partial<Record<EnvKey, string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const saved: Partial<Record<EnvKey, string | undefined>> = {};
  for (const key of Object.keys(env) as EnvKey[]) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved) as EnvKey[]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function routeUrl(params: Record<string, string> = {}): string {
  const url = new URL('https://preview.example.com/api/debug/mercadopago-identity');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

interface CallRouteOptions {
  params?: Record<string, string>;
  adminToken?: string | null;
  mpToken?: string | undefined;
  fetchImpl?: typeof fetch;
}

async function callRoute(options: CallRouteOptions = {}): Promise<Response> {
  const { params, adminToken = ADMIN_SECRET, fetchImpl } = options;
  // `undefined` explícito = borrar la variable (para probar el 503), no "usar la default".
  const mpToken = Object.prototype.hasOwnProperty.call(options, 'mpToken') ? options.mpToken : MP_TOKEN;
  return withEnv(
    {
      ADMIN_API_SECRET: ADMIN_SECRET,
      MERCADOPAGO_ACCESS_TOKEN: mpToken,
      MERCADOPAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
    async () => {
      const headers: Record<string, string> = {};
      if (adminToken) headers['x-admin-token'] = adminToken;
      const request = new NextRequest(routeUrl(params), { headers });

      const originalFetch = globalThis.fetch;
      if (fetchImpl) globalThis.fetch = fetchImpl;
      try {
        return await GET(request);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
}

// ── Payloads CRUDOS de MP (con datos sensibles que NO deben salir) ──────────────
const RAW_USER = {
  id: 3228895377,
  nickname: 'TESTUSER3228895377',
  email: 'seller@example.com',
  site_id: 'MPE',
  country_id: 'PE',
  phone: { area_code: '51', number: '999999999' },
  address: { city: 'Lima', zip_code: '15001' },
  identification: { type: 'DNI', number: '12345678' },
  tags: ['test_user'],
  registration_date: '2024-01-01T00:00:00.000Z',
};

const RAW_PREFERENCE = {
  id: PREFERENCE_ID,
  collector_id: 3228895377,
  client_id: '123456789',
  external_reference: 'UM-2026-001015',
  notification_url: 'https://umantai-git-feat-ecommerce-core-umantai.vercel.app/api/payments/webhook',
  init_point: 'https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=abc',
  sandbox_init_point: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=abc',
  live_mode: false,
  application_id: '2941480109554451',
  payer: { email: 'buyer@example.com', identification: { type: 'DNI', number: '87654321' } },
  metadata: { order_number: 'UM-2026-001015' },
};

const RAW_PAYMENT = {
  id: 182148824342,
  status: 'approved',
  status_detail: 'accredited',
  external_reference: 'UM-2026-001015',
  live_mode: true,
  collector_id: 3228895377,
  application_id: '2941480109554451',
  sponsor_id: '999999',
  transaction_amount: 749,
  currency_id: 'PEN',
  payment_method_id: 'yape',
  payment_type_id: 'bank_transfer',
  authorization_code: '1234567',
  payer: {
    email: 'buyer@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
    identification: { type: 'DNI', number: '87654321' },
    phone: { number: '988887777' },
  },
  card: { first_six_digits: '123456', last_four_digits: '7890', cardholder: { name: 'Ada' } },
};

/** `fetch` mock que responde según la URL consultada. */
function fullMockFetch(init?: { calls: string[] }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    init?.calls.push(url);
    if (url.endsWith('/users/me')) return Response.json(RAW_USER, { status: 200 });
    if (url.includes('/checkout/preferences/')) return Response.json(RAW_PREFERENCE, { status: 200 });
    if (url.includes('/v1/payments/')) return Response.json(RAW_PAYMENT, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

// =============================================================================
//  1. Sin admin token → 401
// =============================================================================
test('sin admin token → 401', async () => {
  const response = await callRoute({ adminToken: null });
  assert.equal(response.status, 401);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.code, 'admin_unauthorized');
});

test('admin token inválido → 401', async () => {
  const response = await callRoute({ adminToken: 'token-equivocado' });
  assert.equal(response.status, 401);
});

// =============================================================================
//  2. Sin MERCADOPAGO_ACCESS_TOKEN → 503
// =============================================================================
test('sin token de Mercado Pago → 503', async () => {
  const response = await callRoute({ mpToken: undefined });
  assert.equal(response.status, 503);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.code, 'mercadopago_not_configured');
});

// =============================================================================
//  3/4/5. Respuesta válida → solo campos permitidos
// =============================================================================
test('/users/me → solo campos permitidos y sin datos sensibles', async () => {
  const response = await callRoute({ fetchImpl: fullMockFetch() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    user: { ok: boolean; status: number; data: Record<string, unknown> };
  };
  assert.equal(body.ok, true);
  assert.equal(body.user.ok, true);
  assert.equal(body.user.status, 200);
  assert.deepEqual(Object.keys(body.user.data).sort(), ['countryId', 'id', 'nickname', 'siteId']);
  assert.equal(body.user.data.id, 3228895377);
  assert.equal(body.user.data.siteId, 'MPE');
  assert.equal(body.user.data.countryId, 'PE');
  assert.equal(body.user.data.nickname, 'TESTUSER3228895377');

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('seller@example.com'), false, 'no debe salir el email del vendedor');
  assert.equal(serialized.includes('12345678'), false, 'no debe salir el DNI del vendedor');
  assert.equal(serialized.includes('999999999'), false, 'no debe salir el teléfono del vendedor');
});

test('preference → solo campos permitidos y sin datos del comprador', async () => {
  const response = await callRoute({
    params: { preferenceId: PREFERENCE_ID },
    fetchImpl: fullMockFetch(),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { preference: { ok: boolean; data: Record<string, unknown> } };
  assert.equal(body.preference.ok, true);
  assert.deepEqual(
    Object.keys(body.preference.data).sort(),
    [
      'applicationId',
      'clientId',
      'collectorId',
      'externalReference',
      'hasInitPoint',
      'hasSandboxInitPoint',
      'id',
      'liveMode',
      'notificationUrl',
    ],
  );
  assert.equal(body.preference.data.collectorId, 3228895377);
  assert.equal(body.preference.data.clientId, '123456789');
  assert.equal(body.preference.data.applicationId, '2941480109554451');
  assert.equal(body.preference.data.externalReference, 'UM-2026-001015');
  assert.equal(body.preference.data.hasInitPoint, true);
  assert.equal(body.preference.data.hasSandboxInitPoint, true);
  assert.equal(body.preference.data.liveMode, false);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('buyer@example.com'), false);
  assert.equal(serialized.includes('87654321'), false);
});

test('payment → solo campos permitidos y sin datos del comprador ni tarjeta', async () => {
  const response = await callRoute({
    params: { paymentId: PAYMENT_ID },
    fetchImpl: fullMockFetch(),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { payment: { ok: boolean; data: Record<string, unknown> } };
  assert.equal(body.payment.ok, true);
  assert.deepEqual(
    Object.keys(body.payment.data).sort(),
    [
      'applicationId',
      'collectorId',
      'currencyId',
      'externalReference',
      'id',
      'liveMode',
      'paymentMethodId',
      'paymentTypeId',
      'sponsorId',
      'status',
      'statusDetail',
      'transactionAmount',
    ],
  );
  assert.equal(body.payment.data.id, PAYMENT_ID);
  assert.equal(body.payment.data.status, 'approved');
  assert.equal(body.payment.data.statusDetail, 'accredited');
  assert.equal(body.payment.data.liveMode, true);
  assert.equal(body.payment.data.collectorId, 3228895377);
  assert.equal(body.payment.data.applicationId, '2941480109554451');
  assert.equal(body.payment.data.sponsorId, '999999');
  assert.equal(body.payment.data.transactionAmount, 749);
  assert.equal(body.payment.data.currencyId, 'PEN');
  assert.equal(body.payment.data.paymentMethodId, 'yape');
  assert.equal(body.payment.data.paymentTypeId, 'bank_transfer');

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('buyer@example.com'), false, 'email del pagador');
  assert.equal(serialized.includes('87654321'), false, 'DNI del pagador');
  assert.equal(serialized.includes('Ada'), false, 'nombre del pagador');
  assert.equal(serialized.includes('123456'), false, 'datos de tarjeta');
  assert.equal(serialized.includes('1234567'), false, 'authorization_code');
});

// =============================================================================
//  6. No se filtran secretos ni la cabecera Authorization
// =============================================================================
test('la respuesta NUNCA filtra access token, webhook secret ni Authorization', async () => {
  const response = await callRoute({
    params: { preferenceId: PREFERENCE_ID, paymentId: PAYMENT_ID },
    fetchImpl: fullMockFetch(),
  });
  const serialized = JSON.stringify(await response.json());

  assert.equal(serialized.includes(MP_TOKEN), false, 'no debe filtrarse el access token');
  assert.equal(serialized.includes(WEBHOOK_SECRET), false, 'no debe filtrarse el webhook secret');
  assert.equal(/authorization/i.test(serialized), false, 'no debe aparecer Authorization');
  assert.equal(serialized.includes('Bearer'), false, 'no debe aparecer el esquema Bearer');
});

test('el token viaja como Bearer hacia MP pero no se devuelve', async () => {
  const captured: RequestInit[] = [];
  const spyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(init ?? {});
    return Response.json(RAW_USER, { status: 200 });
  }) as typeof fetch;

  const response = await callRoute({ fetchImpl: spyFetch });
  const bodyText = JSON.stringify(await response.json());

  assert.equal(captured.length, 1);
  const headers = (captured[0].headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${MP_TOKEN}`, 'el token se usa server-side');
  assert.equal(bodyText.includes(MP_TOKEN), false, 'pero jamás se devuelve');
});

// =============================================================================
//  7. Errores de MP sanitizados
// =============================================================================
test('error 401 de MP queda sanitizado (sin body crudo ni secretos)', async () => {
  const leakingFetch = (async () =>
    new Response(JSON.stringify({ error: 'unauthorized', message: `invalid token ${MP_TOKEN}` }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const report = await collectMercadoPagoIdentity(
    { preferenceId: PREFERENCE_ID, paymentId: PAYMENT_ID },
    { accessToken: MP_TOKEN, fetchImpl: leakingFetch },
  );

  assert.equal(report.user.ok, false);
  if (!report.user.ok) {
    assert.equal(report.user.status, 401);
    assert.match(report.user.reason, /unauthorized/);
    assert.equal(report.user.reason.includes(MP_TOKEN), false, 'el token no debe aparecer en el motivo');
  }
  assert.equal(report.preference?.ok, false);
  assert.equal(report.payment?.ok, false);
  assert.equal(JSON.stringify(report).includes(MP_TOKEN), false);
});

test('404 de MP → not_found y sin body crudo', async () => {
  const notFoundFetch = (async () =>
    new Response(JSON.stringify({ error: 'not_found', message: 'payment not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const report = await collectMercadoPagoIdentity(
    { paymentId: PAYMENT_ID },
    { accessToken: MP_TOKEN, fetchImpl: notFoundFetch },
  );
  assert.equal(report.payment?.ok, false);
  if (report.payment && !report.payment.ok) {
    assert.equal(report.payment.status, 404);
    assert.match(report.payment.reason, /not_found/);
  }
});

test('fallo de red → network_error; abort → timeout', async () => {
  const netFetch = (async () => {
    throw new Error('socket hang up');
  }) as typeof fetch;
  const netReport = await collectMercadoPagoIdentity({}, { accessToken: MP_TOKEN, fetchImpl: netFetch });
  assert.equal(netReport.user.ok, false);
  if (!netReport.user.ok) {
    assert.equal(netReport.user.status, 0);
    assert.equal(netReport.user.reason, 'network_error');
  }

  const abortFetch = (async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;
  const abortReport = await collectMercadoPagoIdentity({}, { accessToken: MP_TOKEN, fetchImpl: abortFetch });
  assert.equal(abortReport.user.ok, false);
  if (!abortReport.user.ok) {
    assert.equal(abortReport.user.reason, 'timeout');
  }
});

// =============================================================================
//  Proyecciones puras + validación de ids
// =============================================================================
test('sanitizeMpUser descarta nickname con @ (evita exponer un email)', () => {
  const user = sanitizeMpUser({ id: 1, nickname: 'user@example.com', site_id: 'MPE' });
  assert.equal(user.nickname, null);
  assert.equal(user.id, 1);
  assert.equal(user.siteId, 'MPE');
});

test('sanitizeMpPreference/sanitizeMpPayment toleran entradas nulas', () => {
  const pref = sanitizeMpPreference(null);
  assert.equal(pref.id, null);
  assert.equal(pref.hasInitPoint, false);
  assert.equal(pref.liveMode, null);

  const pay = sanitizeMpPayment(undefined);
  assert.equal(pay.id, null);
  assert.equal(pay.transactionAmount, null);
});

test('normalizeResourceId valida y acota el identificador', () => {
  assert.equal(normalizeResourceId('182148824342'), '182148824342');
  assert.equal(normalizeResourceId(' 3228895377-abc_def '), '3228895377-abc_def');
  assert.equal(normalizeResourceId(''), null);
  assert.equal(normalizeResourceId('   '), null);
  assert.equal(normalizeResourceId('bad/id'), null);
  assert.equal(normalizeResourceId('a'.repeat(65)), null);
});

test('sin preferenceId ni paymentId → secciones opcionales en null', async () => {
  const report = await collectMercadoPagoIdentity({}, { accessToken: MP_TOKEN, fetchImpl: fullMockFetch() });
  assert.equal(report.preference, null);
  assert.equal(report.payment, null);
  assert.equal(report.user.ok, true);
});
