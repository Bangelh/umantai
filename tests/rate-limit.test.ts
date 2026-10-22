/**
 * tests/rate-limit.test.ts — límite de tasa con backend sustituible.
 *
 * Cubre el algoritmo en memoria, la ventana, el reset, el fail-closed cuando el
 * provider distribuido falla y que la clave no conserve la IP completa.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  enforceRateLimit,
  getRateLimitProviderName,
  MemoryRateLimitProvider,
  rateLimitKeyFor,
  resetRateLimits,
  setRateLimitProvider,
} from '../lib/rate-limit.server';

afterEach(async () => {
  await resetRateLimits();
});

test('permite hasta el límite y luego bloquea con reintento', async () => {
  const provider = new MemoryRateLimitProvider();
  const first = await provider.consume('k', 2, 60_000);
  const second = await provider.consume('k', 2, 60_000);
  const third = await provider.consume('k', 2, 60_000);

  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfterSeconds >= 1);
});

test('la ventana expira y vuelve a habilitar', async () => {
  const provider = new MemoryRateLimitProvider();
  await provider.consume('k', 1, 10);
  assert.equal((await provider.consume('k', 1, 10)).allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await provider.consume('k', 1, 10)).allowed, true);
});

test('providers distintos no comparten cupo y reset lo vacía', async () => {
  const provider = new MemoryRateLimitProvider();
  await provider.consume('a', 1, 60_000);
  assert.equal((await provider.consume('b', 1, 60_000)).allowed, true);
  assert.equal((await provider.consume('a', 1, 60_000)).allowed, false);

  await provider.reset();
  assert.equal((await provider.consume('a', 1, 60_000)).allowed, true);
});

test('si el provider distribuido falla, la ruta se cierra', async () => {
  setRateLimitProvider({
    name: 'broken',
    async consume() {
      throw new Error('redis down');
    },
  });

  assert.equal(getRateLimitProviderName(), 'broken');
  const result = await enforceRateLimit(
    new Request('https://x.test/api/contact', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
    'contact',
    { limit: 5, windowMs: 60_000 },
  );

  assert.deepEqual(result, { allowed: false, remaining: 0, retryAfterSeconds: 60 });
});

test('la clave agrupa por IP sin guardar la IP completa', () => {
  const a = rateLimitKeyFor(
    new Request('https://x.test', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }),
    'contact',
  );
  const b = rateLimitKeyFor(
    new Request('https://x.test', { headers: { 'x-forwarded-for': '203.0.113.9' } }),
    'contact',
  );
  const other = rateLimitKeyFor(
    new Request('https://x.test', { headers: { 'x-forwarded-for': '203.0.113.10' } }),
    'contact',
  );

  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.match(a, /^contact:[a-z0-9]+$/);
  assert.doesNotMatch(a, /203\.0\.113/);
});

test('enforceRateLimit usa la ventana pedida', async () => {
  const request = new Request('https://x.test/api/contact', {
    headers: { 'x-forwarded-for': '198.51.100.5' },
  });
  assert.equal((await enforceRateLimit(request, 's', { limit: 1, windowMs: 60_000 })).allowed, true);
  const blocked = await enforceRateLimit(request, 's', { limit: 1, windowMs: 60_000 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
});
