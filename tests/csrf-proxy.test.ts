/**
 * tests/csrf-proxy.test.ts — guardia de origen (CSRF) y CSP por request.
 *
 * Ejercita `proxy.ts` como lo haría Next: una request con método mutante y un
 * `Origin` ajeno debe rechazarse antes de tocar la ruta; los webhooks con firma
 * propia y los métodos seguros pasan. También verifica que la CSP viaje con
 * nonce en la respuesta.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { proxy } from '../proxy';

const SAME_ORIGIN = 'https://staging.example.com';

function request(path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
  return new NextRequest(`${SAME_ORIGIN}${path}`, init);
}

test('POST con Origin ajeno se rechaza con 403', async () => {
  const response = proxy(
    request('/api/orders', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    }),
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'csrf_origin_rejected');
});

test('POST cross-site sin Origin también se rechaza', () => {
  const response = proxy(
    request('/api/contact', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    }),
  );

  assert.equal(response.status, 403);
});

test('POST del mismo origen pasa y recibe CSP con nonce', () => {
  const response = proxy(
    request('/api/orders', {
      method: 'POST',
      headers: { origin: SAME_ORIGIN },
    }),
  );

  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp, 'falta la CSP');
  const scriptSrc = csp!.split('; ').find((part) => part.startsWith('script-src'));
  assert.ok(scriptSrc);
  assert.match(scriptSrc!, /'nonce-[^']+'/);
  assert.doesNotMatch(scriptSrc!, /unsafe-inline/);
  assert.ok(response.headers.get('x-request-id'));
  assert.ok(response.headers.get('x-nonce'));
});

test('los webhooks y el cron quedan fuera del guardia de origen', () => {
  for (const path of [
    '/api/payments/webhook',
    '/api/mp-orders/webhook',
    '/api/cron/billing',
    '/api/cron/expire-reservations',
    '/api/payload/tiendas',
  ]) {
    const response = proxy(
      request(path, { method: 'POST', headers: { origin: 'https://evil.example' } }),
    );
    assert.equal(response.status, 200, `${path} debería estar exento`);
  }
});

test('los métodos seguros no se bloquean por origen', () => {
  const response = proxy(
    request('/api/products?q=arroz', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    }),
  );

  assert.equal(response.status, 200);
});

test('un Origin malformado no se interpreta como mismo origen', () => {
  const response = proxy(
    request('/api/orders', {
      method: 'POST',
      headers: { origin: 'not-a-url' },
    }),
  );

  assert.equal(response.status, 403);
});
