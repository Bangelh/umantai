import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContentSecurityPolicy, createNonce } from '../lib/security-headers';

test('script-src usa nonce y no permite unsafe-inline', () => {
  const csp = buildContentSecurityPolicy({ nonce: 'abc123' });
  const scriptSrc = csp.split('; ').find((part) => part.startsWith('script-src'));
  assert.ok(scriptSrc, 'falta script-src');
  assert.match(scriptSrc!, /'nonce-abc123'/);
  assert.doesNotMatch(scriptSrc!, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/, 'producción no debe permitir eval');
});

test('desarrollo agrega unsafe-eval pero mantiene el nonce', () => {
  const csp = buildContentSecurityPolicy({ nonce: 'dev-nonce', isDev: true });
  assert.match(csp, /'nonce-dev-nonce'/);
  assert.match(csp, /'unsafe-eval'/);
  const scriptSrc = csp.split('; ').find((part) => part.startsWith('script-src'));
  assert.ok(scriptSrc);
  assert.doesNotMatch(scriptSrc!, /unsafe-inline/);
});

test('el nonce es distinto en cada llamada y no vacío', () => {
  const a = createNonce();
  const b = createNonce();
  assert.ok(a.length >= 16);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9+/=]+$/);
});

test('directivas base siguen presentes', () => {
  const csp = buildContentSecurityPolicy({ nonce: 'n' });
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    'upgrade-insecure-requests',
  ]) {
    assert.ok(csp.includes(directive), `falta ${directive}`);
  }
});
