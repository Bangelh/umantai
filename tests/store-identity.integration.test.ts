/**
 * tests/store-identity.integration.test.ts — PostgreSQL real (efímero, local).
 *
 * Cubre la edición de nombre + dirección pública (slug) mientras la tienda no
 * haya sido publicada:
 *   · slug válido y normalizado, sin tocar la ubicación;
 *   · slug ocupado (case-insensitive) → 409 de negocio;
 *   · slug reservado → rechazo de negocio;
 *   · nombre/slug vacíos o inválidos;
 *   · usuario sin membresía → sin acceso;
 *   · tienda activa o ya aprobada → bloqueada.
 *
 * Nunca lee DATABASE_URL ni toca staging/Producción: el helper crea su propio
 * cluster en localhost y lo borra al terminar.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';
import { TenancyError } from '../lib/tenancy';

type Stores = typeof import('../lib/stores.server');
type Platform = typeof import('../lib/platform-db.server');
type AuthModule = typeof import('../lib/auth.server');

let database: EmbeddedTestDatabase;
let stores: Stores;
let platform: Platform;
let authModule: AuthModule;
let auth: ReturnType<AuthModule['getAuthServer']>;

const PASSWORD = 'uma-ntai-test-123456';

interface TestUser {
  id: string;
  email: string;
}

before(async () => {
  database = await startTestDatabase();

  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  process.env.BETTER_AUTH_SECRET = 'integration-secret-'.padEnd(48, 'x');
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.NEXT_PUBLIC_SERVER_URL = 'http://localhost:3000';
  delete process.env.VERCEL_ENV;

  stores = await import('../lib/stores.server');
  platform = await import('../lib/platform-db.server');
  authModule = await import('../lib/auth.server');
  auth = authModule.getAuthServer();
});

after(async () => {
  await authModule.closeAuthPool().catch(() => undefined);
  await closeDbPools();
  if (database) await database.stop();
});

async function signUp(email: string, name: string): Promise<TestUser> {
  const response = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    }),
  );

  const body = (await response.json().catch(() => null)) as
    | { user?: { id?: string }; message?: string }
    | null;

  assert.equal(response.status, 200, `sign-up falló: ${JSON.stringify(body)}`);
  assert.ok(body?.user?.id, 'sign-up no devolvió user.id');
  return { id: String(body?.user?.id), email };
}

interface TestStore {
  id: string;
  slug: string;
  name: string;
}

async function makeStore(
  owner: TestUser,
  input: { name: string; slug: string; withLocation?: boolean },
): Promise<TestStore> {
  const created = await stores.createStoreForOwner({
    ownerUserId: owner.id,
    name: input.name,
    slug: input.slug,
    category: 'test',
    ...(input.withLocation === false
      ? {}
      : {
          address: 'Calle Luis Valle Goicochea 309',
          ubigeo: '130101',
          locationSource: 'map_pin',
          latitude: -8.1116,
          longitude: -79.0287,
        }),
  });
  return { id: created.id, slug: created.slug, name: created.name };
}

function slug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function assertTenancyError(promise: Promise<unknown>, code: string, label: string) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TenancyError, `${label}: se esperaba TenancyError`);
    assert.equal((error as TenancyError).code, code, `${label}: código incorrecto`);
    return true;
  });
}

const owner = {} as TestUser;
const outsider = {} as TestUser;
const store = {} as TestStore;

test('setup: dos identidades con una tienda cada una', async () => {
  Object.assign(owner, await signUp('identity-owner@example.invalid', 'Owner'));
  Object.assign(outsider, await signUp('identity-outsider@example.invalid', 'Outsider'));

  Object.assign(
    store,
    await makeStore(owner, { name: 'Juan Store', slug: slug('juan-store') }),
  );
});

test('tienda nunca publicada: guarda nombre y slug normalizados sin tocar la ubicación', async () => {
  const updated = await stores.updateStoreIdentity(owner.id, store.id, {
    name: '  Juan’s Store  ',
    slug: 'Juan’s Store',
  });

  assert.equal(updated.name, 'Juan’s Store');
  assert.equal(updated.slug, 'juan-s-store');
  assert.equal(updated.active, false);
  assert.equal(updated.approvedAt, null);

  // La ubicación no se movió: el slug no describe dónde está la tienda.
  assert.equal(updated.ubigeo, '130101');
  assert.equal(updated.department, 'La Libertad');
  assert.equal(updated.province, 'Trujillo');
  assert.equal(updated.district, 'Trujillo');
  assert.equal(updated.address, 'Calle Luis Valle Goicochea 309');
  assert.ok(Math.abs((updated.latitude ?? 0) - -8.1116) < 0.0001);
  assert.ok(Math.abs((updated.longitude ?? 0) - -79.0287) < 0.0001);

  // El slug anterior ya no existe en la tabla (…/juan-store deja de resolver).
  const sql = platform.requirePlatformSql();
  const rows = await sql`SELECT COUNT(*)::int AS count FROM stores WHERE slug = ${store.slug}`;
  assert.equal(Number(rows[0]?.count), 0);
});

test('slug ocupado (case-insensitive) se rechaza sin tocar ninguna fila', async () => {
  const other = await makeStore(outsider, {
    name: 'Otra Tienda',
    slug: 'otra-tienda',
    withLocation: false,
  });

  await assertTenancyError(
    stores.updateStoreIdentity(owner.id, store.id, {
      name: 'Juan’s Store',
      slug: 'OTRA-TIENDA',
    }),
    'store_slug_taken',
    'slug ocupado',
  );

  const mine = (await stores.listStoresForUser(owner.id)).find((item) => item.id === store.id);
  assert.equal(mine?.slug, 'juan-s-store');
  assert.equal(mine?.name, 'Juan’s Store');
  assert.equal(other.slug, 'otra-tienda');
});

test('slug reservado se rechaza (admin, api, vender…)', async () => {
  for (const reserved of ['admin', 'api', 'vender']) {
    await assertTenancyError(
      stores.updateStoreIdentity(owner.id, store.id, { name: 'Juan’s Store', slug: reserved }),
      'store_slug_reserved',
      `slug reservado ${reserved}`,
    );
  }

  const mine = (await stores.listStoresForUser(owner.id)).find((item) => item.id === store.id);
  assert.equal(mine?.slug, 'juan-s-store');
});

test('nombre o slug vacíos/inválidos no guardan nada', async () => {
  await assertTenancyError(
    stores.updateStoreIdentity(owner.id, store.id, { name: 'A', slug: 'juan-s-store' }),
    'invalid_store_input',
    'nombre demasiado corto',
  );
  await assertTenancyError(
    stores.updateStoreIdentity(owner.id, store.id, { name: 'Juan’s Store', slug: '   ' }),
    'invalid_store_input',
    'slug vacío',
  );
  await assertTenancyError(
    stores.updateStoreIdentity(owner.id, store.id, { name: 'Juan’s Store', slug: '---' }),
    'invalid_store_input',
    'slug sin caracteres válidos',
  );

  const mine = (await stores.listStoresForUser(owner.id)).find((item) => item.id === store.id);
  assert.equal(mine?.slug, 'juan-s-store');
  assert.equal(mine?.name, 'Juan’s Store');
});

test('un usuario sin membresía no puede cambiar la identidad', async () => {
  await assertTenancyError(
    stores.updateStoreIdentity(outsider.id, store.id, {
      name: 'Tomada por otro',
      slug: 'tomada-por-otro',
    }),
    'store_forbidden',
    'sin membresía',
  );

  const mine = (await stores.listStoresForUser(owner.id)).find((item) => item.id === store.id);
  assert.equal(mine?.slug, 'juan-s-store');
});

test('una tienda activa no puede cambiar de dirección', async () => {
  const sql = platform.requirePlatformSql();
  await sql`
    UPDATE stores SET active = TRUE, approved_at = NOW()
     WHERE id = ${store.id}::uuid
  `;

  await assertTenancyError(
    stores.updateStoreIdentity(owner.id, store.id, {
      name: 'Juan’s Store',
      slug: 'juan-s-store-trujillo',
    }),
    'store_identity_locked',
    'tienda activa',
  );

  const rows = await sql`SELECT slug, active FROM stores WHERE id = ${store.id}::uuid`;
  assert.equal(String(rows[0]?.slug), 'juan-s-store');
  assert.equal(rows[0]?.active, true);
});

test('una tienda ya aprobada (aunque esté inactiva) tampoco cambia', async () => {
  const parked = await makeStore(owner, {
    name: 'Tienda Pausada',
    slug: slug('pausada'),
  });

  const sql = platform.requirePlatformSql();
  await sql`UPDATE stores SET approved_at = NOW() WHERE id = ${parked.id}::uuid`;

  await assertTenancyError(
    stores.updateStoreIdentity(owner.id, parked.id, {
      name: 'Tienda Pausada',
      slug: slug('pausada-nueva'),
    }),
    'store_identity_locked',
    'tienda aprobada',
  );

  const rows = await sql`SELECT slug FROM stores WHERE id = ${parked.id}::uuid`;
  assert.equal(String(rows[0]?.slug), parked.slug);
});
