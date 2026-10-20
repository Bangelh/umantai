/**
 * tests/platform-admin.test.ts — sesión firmada de Platform Admin.
 *
 * Cubre la firma HMAC, expiración, manipulación, allowlist de bootstrap y que
 * `requireAdminToken` acepte la cookie sin necesitar el token compartido.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlatformAdminToken,
  isPlatformAdminUser,
  PLATFORM_ADMIN_COOKIE,
  PLATFORM_ADMIN_TTL_SECONDS,
  verifyPlatformAdminToken,
} from '../lib/platform-admin.server';
import { requireAdminToken } from '../lib/admin.server';

const SECRET = 'test-platform-admin-secret-0123456789abcdef';
const saved = {
  secret: process.env.PLATFORM_ADMIN_SECRET,
  emails: process.env.PLATFORM_ADMIN_EMAILS,
  admin: process.env.ADMIN_API_SECRET,
  appEnv: process.env.APP_ENV,
  databaseUrl: process.env.DATABASE_URL,
  postgresUrl: process.env.POSTGRES_URL,
  postgresUrlDirect: process.env.POSTGRES_URL_NON_POOLING,
  integrationUrl: process.env.INTEGRATION_DATABASE_URL,
};

before(() => {
  process.env.PLATFORM_ADMIN_SECRET = SECRET;
  process.env.PLATFORM_ADMIN_EMAILS = 'Admin@Example.com';
  delete process.env.ADMIN_API_SECRET;
  delete process.env.APP_ENV;
  // Este test es de unidad: nunca debe consultar una base externa.
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL_NON_POOLING;
  delete process.env.INTEGRATION_DATABASE_URL;
});

after(() => {
  if (saved.secret === undefined) delete process.env.PLATFORM_ADMIN_SECRET;
  else process.env.PLATFORM_ADMIN_SECRET = saved.secret;
  if (saved.emails === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = saved.emails;
  if (saved.admin === undefined) delete process.env.ADMIN_API_SECRET;
  else process.env.ADMIN_API_SECRET = saved.admin;
  if (saved.appEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = saved.appEnv;
  if (saved.databaseUrl !== undefined) process.env.DATABASE_URL = saved.databaseUrl;
  if (saved.postgresUrl !== undefined) process.env.POSTGRES_URL = saved.postgresUrl;
  if (saved.postgresUrlDirect !== undefined)
    process.env.POSTGRES_URL_NON_POOLING = saved.postgresUrlDirect;
  if (saved.integrationUrl !== undefined)
    process.env.INTEGRATION_DATABASE_URL = saved.integrationUrl;
});

test('crea y verifica una sesión de admin', () => {
  const token = createPlatformAdminToken('user-123');
  assert.ok(token);
  assert.deepEqual(verifyPlatformAdminToken(token), { userId: 'user-123' });
});

test('rechaza token manipulado o con firma inválida', () => {
  const token = createPlatformAdminToken('user-123');
  assert.ok(token);

  const [payload, signature] = token.split('.');
  assert.equal(verifyPlatformAdminToken(`${payload}.${signature}x`), null);
  assert.equal(verifyPlatformAdminToken(`${payload}x.${signature}`), null);
  assert.equal(verifyPlatformAdminToken('basura'), null);
  assert.equal(verifyPlatformAdminToken(null), null);
});

test('rechaza una sesión expirada', () => {
  const issuedAt = 1_000_000;
  const token = createPlatformAdminToken('user-123', issuedAt);
  assert.ok(token);
  assert.ok(verifyPlatformAdminToken(token, issuedAt + PLATFORM_ADMIN_TTL_SECONDS - 1));
  assert.equal(verifyPlatformAdminToken(token, issuedAt + PLATFORM_ADMIN_TTL_SECONDS), null);
});

test('falla cerrado si falta el secreto', () => {
  const previous = process.env.PLATFORM_ADMIN_SECRET;
  delete process.env.PLATFORM_ADMIN_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  try {
    assert.equal(createPlatformAdminToken('user-123'), null);
  } finally {
    process.env.PLATFORM_ADMIN_SECRET = previous;
  }
});

test('allowlist de bootstrap normaliza el correo', async () => {
  assert.equal(await isPlatformAdminUser({ id: 'x', email: 'admin@example.com' }), true);
  assert.equal(await isPlatformAdminUser({ id: 'x', email: 'otro@example.com' }), false);
});

test('requireAdminToken acepta la cookie y no exige el token compartido', () => {
  const token = createPlatformAdminToken('user-123');
  assert.ok(token);

  const request = new Request('https://staging.example.com/api/admin/plans', {
    headers: { cookie: `${PLATFORM_ADMIN_COOKIE}=${encodeURIComponent(token)}` },
  });

  const access = requireAdminToken(request);
  assert.equal(access.ok, true);
  if (access.ok) {
    assert.equal(access.via, 'session');
    assert.equal(access.userId, 'user-123');
  }
});
