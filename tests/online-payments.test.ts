/**
 * tests/online-payments.test.ts — cobro online congelado.
 *
 * Mercado Pago está congelado por decisión del negocio. Estas pruebas fijan las
 * dos garantías que no deben romperse:
 *
 *   1. El interruptor es explícito: sin `ONLINE_PAYMENTS_ENABLED=1` el cobro
 *      online está apagado, incluso si hay credenciales de Mercado Pago.
 *   2. Con el cobro apagado, /api/payments/preference responde 503 con
 *      `online_payments_unavailable` ANTES de tocar la base o Mercado Pago.
 *
 * No se llama a Mercado Pago: si el endpoint llegara a intentarlo, el `fetch`
 * espía del test lo detecta y la prueba falla.
 */

// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele
// `envConfig`. Nunca se abre una conexión real en este test.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';

import { POST } from '../app/api/payments/preference/route';
import {
  ONLINE_PAYMENTS_ENABLED_ENV,
  isOnlinePaymentEnabled,
} from '../lib/online-payments';

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

/** Orden válida en forma, inexistente de verdad: el candado corta antes de leerla. */
const ORDER_TOKEN = '1f8b8b5e-4c1d-4c0e-9a59-6a1f0f0a1b2c';

function preferenceRequest(token = ORDER_TOKEN): NextRequest {
  return new NextRequest('https://localhost:3000/api/payments/preference', {
    method: 'POST',
    body: JSON.stringify({ token }),
    headers: { 'content-type': 'application/json' },
  });
}

test('el flag está apagado por defecto y solo un valor explícito lo enciende', () => {
  assert.equal(isOnlinePaymentEnabled({}), false, 'sin variable debe estar congelado');
  assert.equal(isOnlinePaymentEnabled({ [ONLINE_PAYMENTS_ENABLED_ENV]: '' }), false);
  assert.equal(isOnlinePaymentEnabled({ [ONLINE_PAYMENTS_ENABLED_ENV]: '0' }), false);
  assert.equal(isOnlinePaymentEnabled({ [ONLINE_PAYMENTS_ENABLED_ENV]: 'false' }), false);
  assert.equal(isOnlinePaymentEnabled({ [ONLINE_PAYMENTS_ENABLED_ENV]: 'sí' }), false);

  assert.equal(isOnlinePaymentEnabled({ [ONLINE_PAYMENTS_ENABLED_ENV]: '1' }), true);
  assert.equal(isOnlinePaymentEnabled({ [ONLINE_PAYMENTS_ENABLED_ENV]: ' TRUE ' }), true);
});

test('congelado: el endpoint responde 503 y NO llama a Mercado Pago', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('no debería llamarse a la red');
  }) as typeof fetch;

  try {
    const response = await withEnv(
      {
        [ONLINE_PAYMENTS_ENABLED_ENV]: undefined,
        // Credenciales presentes a propósito: el candado NO depende de que falten.
        MERCADOPAGO_ACCESS_TOKEN: 'TEST-1234567890-abcdefabcdef-3228895377-abcdefabcdef',
      },
      () => POST(preferenceRequest()),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'online_payments_unavailable');
    assert.equal(fetchCalls, 0, 'no debe llamarse a la API de Mercado Pago');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('congelado: el token se valida antes del candado (mismo 400 de siempre)', async () => {
  const response = await withEnv(
    {
      [ONLINE_PAYMENTS_ENABLED_ENV]: undefined,
      MERCADOPAGO_ACCESS_TOKEN: 'TEST-1234567890-abcdefabcdef-3228895377-abcdefabcdef',
    },
    () => POST(preferenceRequest('no-es-un-uuid')),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, undefined);
});
