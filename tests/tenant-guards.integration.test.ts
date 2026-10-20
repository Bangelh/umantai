/**
 * tests/tenant-guards.integration.test.ts — PostgreSQL real (efímero).
 *
 * Segunda barrera de aislamiento: aunque una ruta tenga un bug, la base no
 * permite adjuntar una imagen de la tienda B a un producto de la tienda A.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type Platform = typeof import('../lib/platform-db.server');

let database: EmbeddedTestDatabase;
let platform: Platform;
let storeA = '';
let storeB = '';
let productA = '';

before(async () => {
  database = await startTestDatabase();
  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  delete process.env.VERCEL_ENV;

  platform = await import('../lib/platform-db.server');
  const sql = platform.requirePlatformSql();

  const stores = await sql`
    INSERT INTO stores (name, slug, active)
    VALUES ('Tienda A', ${`tienda-a-${randomUUID()}`}, FALSE),
           ('Tienda B', ${`tienda-b-${randomUUID()}`}, FALSE)
    RETURNING id
  `;
  storeA = String(stores[0].id);
  storeB = String(stores[1].id);

  const products = await sql`
    INSERT INTO store_products (store_id, slug, name, price_cents)
    VALUES (${storeA}::uuid, ${`producto-${randomUUID()}`}, 'Producto A', 1000)
    RETURNING id
  `;
  productA = String(products[0].id);
});

after(async () => {
  await closeDbPools();
  await database.stop();
});

function mediaKey(label: string): string {
  return `product_image/${storeA}/${label}-${randomUUID()}.jpg`;
}

test('acepta un asset del producto dentro de su tienda', async () => {
  const sql = platform.requirePlatformSql();
  const rows = await sql`
    INSERT INTO media_assets (
      scope, object_key, mime, size_bytes, storage_driver,
      store_id, store_product_id, data
    ) VALUES (
      'product_image', ${mediaKey('ok')}, 'image/jpeg', 10, 'db',
      ${storeA}::uuid, ${productA}::uuid, ${Buffer.from([0xff, 0xd8, 0xff, 0])}
    )
    RETURNING id
  `;
  assert.ok(rows[0]?.id);
});

test('rechaza un asset de la tienda B apuntando al producto de A', async () => {
  const sql = platform.requirePlatformSql();

  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO media_assets (
          scope, object_key, mime, size_bytes, storage_driver,
          store_id, store_product_id, data
        ) VALUES (
          'product_image', ${mediaKey('cross')}, 'image/jpeg', 10, 'db',
          ${storeB}::uuid, ${productA}::uuid, ${Buffer.from([0xff, 0xd8, 0xff, 0])}
        )
      `;
    },
    /media_store_scope_mismatch/,
  );
});

test('rechaza un asset sin tienda para un producto', async () => {
  const sql = platform.requirePlatformSql();

  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO media_assets (
          scope, object_key, mime, size_bytes, storage_driver,
          store_id, store_product_id, data
        ) VALUES (
          'product_image', ${mediaKey('no-store')}, 'image/jpeg', 10, 'db',
          NULL, ${productA}::uuid, ${Buffer.from([0xff, 0xd8, 0xff, 0])}
        )
      `;
    },
    /media_store_required/,
  );
});
