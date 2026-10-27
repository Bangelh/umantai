/**
 * tests/contact-rate-limit.test.ts — cupo REAL de /api/contact a nivel de ruta.
 *
 * Regresión del doble consumo: la ruta tenía `rateLimitGate` **y**
 * `consumeRateLimit` sobre la misma clave y ventana, así que cada envío gastaba
 * dos unidades y el cupo efectivo era la mitad del anunciado (el 3.er envío ya
 * recibía 429). Ahora hay una sola barrera: 5 intentos y el 6.º bloqueado.
 *
 * Se usan payloads inválidos a propósito: el rate limit corre ANTES de la
 * validación, así que no se persiste nada ni se envía correo.
 */

import './helpers/preview-env';

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetRateLimits } from '../lib/rate-limit.server';

const { POST } = await import('../app/api/contact/route');

const INVALID_PAYLOAD = { name: 'x', email: 'no-es-correo', message: 'corto', consent: false };

function submit(ip: string): Request {
  return new Request('https://staging.example.com/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(INVALID_PAYLOAD),
  });
}

function uniqueIp(): string {
  return `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
}

afterEach(async () => {
  await resetRateLimits();
});

test('los intentos 1–5 pasan y el 6.º se bloquea con Retry-After', async () => {
  await resetRateLimits();
  const ip = uniqueIp();

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await POST(submit(ip));
    assert.notEqual(response.status, 429, `el intento ${attempt} no debe estar limitado`);
    // El payload es inválido: se responde 400, nunca se llega a persistir.
    assert.equal(response.status, 400, `intento ${attempt}`);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'invalid_contact');
  }

  const blocked = await POST(submit(ip));
  assert.equal(blocked.status, 429);
  const body = (await blocked.json()) as { ok?: boolean; code?: string; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'rate_limited');
  assert.ok((body.error ?? '').length > 0);

  const retryAfter = Number(blocked.headers.get('retry-after'));
  // Ventana de 10 minutos: entre 1 segundo y los 600 de la ventana completa.
  assert.ok(Number.isFinite(retryAfter), 'Retry-After debe ser numérico');
  assert.ok(retryAfter > 0 && retryAfter <= 600, `Retry-After fuera de rango: ${retryAfter}`);
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
});

test('cada envío gasta UNA unidad del cupo (sin doble consumo)', async () => {
  await resetRateLimits();
  const ip = uniqueIp();

  // 4 intentos: con el bug anterior (2 unidades por envío) el 3.º ya se bloqueaba.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await POST(submit(ip));
    assert.equal(response.status, 400, `intento ${attempt} debería seguir dentro del cupo`);
  }

  // El 5.º todavía entra; recién el 6.º se corta.
  assert.equal((await POST(submit(ip))).status, 400);
  assert.equal((await POST(submit(ip))).status, 429);
});

test('el cupo es por cliente y no se comparte entre IPs', async () => {
  await resetRateLimits();
  const first = uniqueIp();
  const second = uniqueIp();

  for (let attempt = 0; attempt < 5; attempt += 1) await POST(submit(first));
  assert.equal((await POST(submit(first))).status, 429);

  const other = await POST(submit(second));
  assert.equal(other.status, 400, 'otra IP conserva su propio cupo');
});

test('el honeypot sigue respondiendo neutro dentro del cupo', async () => {
  await resetRateLimits();
  const ip = uniqueIp();

  const response = await POST(
    new Request('https://staging.example.com/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ ...INVALID_PAYLOAD, company: 'Acme Spam SA' }),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok?: boolean; delivery?: string };
  assert.equal(body.ok, true);
  assert.equal(body.delivery, 'ignored');
});
