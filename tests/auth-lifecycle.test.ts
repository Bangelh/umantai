/**
 * tests/auth-lifecycle.test.ts — ciclo de sesión en modo test, sin servicios.
 *
 * No hay PostgreSQL ni proveedor externo: se valida el comportamiento cerrado
 * (fail-closed) que protege a la app cuando el entorno no está configurado, la
 * normalización de la URL base y la lectura de la cookie de Platform Admin.
 *
 * El ciclo con base real (registro → login → reset → logout) vive en
 * tests/multi-tenant.integration.test.ts; acá se cubre lo que puede validarse
 * sin red ni contenedores.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeAuthPool,
  getAuthServer,
  getSessionUser,
  isAuthConfigured,
  requireSessionUser,
  resolveAuthBaseUrl,
} from '../lib/auth.server';
import { TenancyError } from '../lib/tenancy';
import {
  PLATFORM_ADMIN_COOKIE,
  PLATFORM_ADMIN_TTL_SECONDS,
  readPlatformAdminCookie,
} from '../lib/platform-admin.server';

const DB_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'BANGELH_DATABASE_URL',
  'BANGELH_POSTGRES_URL',
  'BANGELH_POSTGRES_URL_NON_POOLING',
  'UMANTAI_DATABASE_URL',
  'UMANTAI_POSTGRES_URL',
  'UMANTAI_POSTGRES_URL_NON_POOLING',
  'UMANTAI_URL_DATABASE_URL',
  'UMANTAI_URL_POSTGRES_URL',
  'UMANTAI_URL_POSTGRES_URL_NON_POOLING',
  'INTEGRATION_DATABASE_URL',
] as const;

const saved = new Map<string, string | undefined>();
let savedBaseUrl: string | undefined;

before(() => {
  for (const key of DB_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  savedBaseUrl = process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.NEXT_PUBLIC_SERVER_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

after(async () => {
  await closeAuthPool();
  for (const key of DB_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedBaseUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedBaseUrl;
});

test('sin base de datos el auth falla cerrado y no lanza en lecturas', async () => {
  assert.equal(isAuthConfigured(), false);
  assert.equal(await getSessionUser(new Headers()), null);
  assert.throws(() => getAuthServer(), /auth_db_not_configured/);
  await assert.rejects(
    () => requireSessionUser(new Headers()),
    (error: unknown) => error instanceof TenancyError && error.code === 'not_authenticated',
  );
});

test('la URL base quita la barra final y respeta el entorno', () => {
  process.env.BETTER_AUTH_URL = 'https://staging.example.com///';
  assert.equal(resolveAuthBaseUrl(), 'https://staging.example.com');

  delete process.env.BETTER_AUTH_URL;
  process.env.NEXT_PUBLIC_SERVER_URL = 'https://primary.example.com/';
  assert.equal(resolveAuthBaseUrl(), 'https://primary.example.com');

  delete process.env.NEXT_PUBLIC_SERVER_URL;
});

test('la cookie de Platform Admin se lee solo si existe y no está corrupta', () => {
  assert.equal(readPlatformAdminCookie(new Request('https://x.test')), null);
  assert.equal(
    readPlatformAdminCookie(
      new Request('https://x.test', { headers: { cookie: 'otra=1; otra2=2' } }),
    ),
    null,
  );
  assert.equal(
    readPlatformAdminCookie(
      new Request('https://x.test', {
        headers: { cookie: `${PLATFORM_ADMIN_COOKIE}=abc.def` },
      }),
    ),
    'abc.def',
  );
  assert.equal(
    readPlatformAdminCookie(
      new Request('https://x.test', {
        headers: { cookie: `${PLATFORM_ADMIN_COOKIE}=%E0%A4%A` },
      }),
    ),
    null,
  );
});

test('la sesión de admin dura 8 horas', () => {
  assert.equal(PLATFORM_ADMIN_TTL_SECONDS, 8 * 60 * 60);
});
