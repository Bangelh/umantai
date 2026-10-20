/**
 * tests/rls.integration.test.ts — RLS REAL con rol NO OWNER.
 *
 * Demuestra la segunda barrera de aislamiento:
 *   · sin `app.store_id` no se ve NADA;
 *   · con `app.store_id = A` solo se ve/escribe A;
 *   · una escritura dirigida a B desde A es rechazada por PostgreSQL;
 *   · el dueño del schema (rol de la app) sigue viendo todo: la app actual no
 *     se rompe y RLS queda lista para el rol sin privilegios.
 *
 * PostgreSQL efímero local (001–022). Nunca toca staging ni Producción.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type Platform = typeof import('../lib/platform-db.server');

let database: EmbeddedTestDatabase;
let platform: Platform;

const storeA = randomUUID();
const storeB = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const orderA = randomUUID();
const orderB = randomUUID();
const promo = randomUUID();

function code(error: unknown): string {
  return String((error as { code?: string }).code ?? '');
}

before(async () => {
  database = await startTestDatabase();
  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  delete process.env.VERCEL_ENV;
  platform = await import('../lib/platform-db.server');

  const sql = platform.requirePlatformSql();

  await sql`
    INSERT INTO stores (id, name, slug, active)
    VALUES (${storeA}, 'Tienda RLS A', ${`rls-a-${storeA.slice(0, 8)}`}, FALSE),
           (${storeB}, 'Tienda RLS B', ${`rls-b-${storeB.slice(0, 8)}`}, FALSE)
  `;

  await sql`
    INSERT INTO store_products (id, store_id, slug, name, price_cents)
    VALUES (${productA}, ${storeA}, 'producto-a', 'Producto A', 500),
           (${productB}, ${storeB}, 'producto-b', 'Producto B', 900)
  `;

  await sql`
    INSERT INTO product_variants (store_id, store_product_id, variant_key, sku)
    VALUES (${storeA}, ${productA}, 'color:rojo', ${`SKU-A-${storeA.slice(0, 6)}`}),
           (${storeB}, ${productB}, 'color:azul', ${`SKU-B-${storeB.slice(0, 6)}`})
  `;

  await sql`
    INSERT INTO inventory (store_id, location_code, product_slug, variant_key, quantity_on_hand)
    VALUES (${storeA}, 'MAIN', 'producto-a', '', 10),
           (${storeB}, 'MAIN', 'producto-b', '', 20)
  `;

  await sql`
    INSERT INTO inventory_movements (store_id, inventory_id, movement_type, on_hand_delta, on_hand_after, reserved_after)
    SELECT ${storeA}, id, 'receipt', 10, 10, 0 FROM inventory
     WHERE store_id = ${storeA} AND product_slug = 'producto-a'
  `;
  await sql`
    INSERT INTO inventory_movements (store_id, inventory_id, movement_type, on_hand_delta, on_hand_after, reserved_after)
    SELECT ${storeB}, id, 'receipt', 20, 20, 0 FROM inventory
     WHERE store_id = ${storeB} AND product_slug = 'producto-b'
  `;

  await sql`
    INSERT INTO orders (id, store_id, contact_email, fulfillment_type, subtotal, total)
    VALUES (${orderA}, ${storeA}, 'a@example.invalid', 'pickup_locker', 5, 5),
           (${orderB}, ${storeB}, 'b@example.invalid', 'pickup_locker', 9, 9)
  `;

  await sql`
    INSERT INTO order_items (order_id, line_number, product_slug, product_name, quantity, unit_price, line_total)
    VALUES (${orderA}, 1, 'producto-a', 'Producto A', 1, 5, 5),
           (${orderB}, 1, 'producto-b', 'Producto B', 1, 9, 9)
  `;

  const plans = await sql`SELECT id FROM plans WHERE code = 'free' LIMIT 1`;
  const freePlan = String(plans[0].id);

  await sql`
    INSERT INTO store_subscriptions (store_id, plan_id, status)
    VALUES (${storeA}, ${freePlan}, 'free'),
           (${storeB}, ${freePlan}, 'free')
    ON CONFLICT DO NOTHING
  `;

  await sql`
    INSERT INTO promotions (id, code, name, benefit_type, duration_months)
    VALUES (${promo}, ${`RLS${promo.slice(0, 6).replace(/-/g, '').toUpperCase()}`}, 'Promo RLS', 'free_months', 1)
  `;

  const subs = await sql`
    SELECT id, store_id FROM store_subscriptions WHERE store_id IN (${storeA}, ${storeB})
  `;
  for (const row of subs) {
    await sql`
      INSERT INTO promotion_redemptions (promotion_id, store_id, subscription_id, period_after)
      VALUES (${promo}, ${String(row.store_id)}, ${String(row.id)}, NOW() + INTERVAL '1 month')
      ON CONFLICT DO NOTHING
    `;
  }
});

after(async () => {
  await closeDbPools();
  await database?.stop();
});

/** Conteo tipado por tabla (nunca se interpola un nombre en SQL). */
function countQuery(table: string) {
  const sql = platform.requirePlatformSql();
  switch (table) {
    case 'store_products':
      return sql`SELECT count(*)::int AS n FROM store_products`;
    case 'product_variants':
      return sql`SELECT count(*)::int AS n FROM product_variants`;
    case 'inventory':
      return sql`SELECT count(*)::int AS n FROM inventory`;
    case 'inventory_movements':
      return sql`SELECT count(*)::int AS n FROM inventory_movements`;
    case 'orders':
      return sql`SELECT count(*)::int AS n FROM orders`;
    case 'order_items':
      return sql`SELECT count(*)::int AS n FROM order_items`;
    case 'store_subscriptions':
      return sql`SELECT count(*)::int AS n FROM store_subscriptions`;
    case 'promotion_redemptions':
      return sql`SELECT count(*)::int AS n FROM promotion_redemptions`;
    default:
      throw new Error(`tabla no soportada: ${table}`);
  }
}

/** Consulta con el rol tenant y la tienda fijada en la transacción. */
async function scopedCount(storeId: string | null, table: string): Promise<number> {
  const sql = platform.requirePlatformSql();
  const queries = [
    sql`SET LOCAL ROLE umantai_tenant`,
    ...(storeId ? [sql`SELECT set_config('app.store_id', ${storeId}, true)`] : []),
    countQuery(table),
  ];
  const results = await sql.transaction(queries);
  const last = results[results.length - 1]?.[0];
  return Number(last?.n ?? 0);
}

const TABLES = [
  'store_products',
  'product_variants',
  'inventory',
  'inventory_movements',
  'orders',
  'order_items',
  'store_subscriptions',
  'promotion_redemptions',
];

test('sin app.store_id el rol tenant no ve ninguna fila', async () => {
  for (const table of TABLES) {
    assert.equal(await scopedCount(null, table), 0, `${table} debería estar vacía sin store_id`);
  }
});

test('con app.store_id = A solo se ven filas de A', async () => {
  for (const table of TABLES) {
    assert.equal(await scopedCount(storeA, table), 1, `${table} debería ver 1 fila de A`);
  }
});

test('con app.store_id = B solo se ven filas de B', async () => {
  for (const table of TABLES) {
    assert.equal(await scopedCount(storeB, table), 1, `${table} debería ver 1 fila de B`);
  }
});

test('UPDATE de otra tienda afecta 0 filas (la query olvidó store_id)', async () => {
  const sql = platform.requirePlatformSql();
  const [, , updated] = await sql.transaction([
    sql`SET LOCAL ROLE umantai_tenant`,
    sql`SELECT set_config('app.store_id', ${storeA}, true)`,
    sql`UPDATE store_products SET name = 'Hackeado' WHERE store_id = ${storeB}::uuid RETURNING id`,
  ]);
  assert.equal(updated.length, 0);

  // Y la fila de B sigue intacta vista por el dueño.
  const rows = await sql`SELECT name FROM store_products WHERE id = ${productB}::uuid`;
  assert.equal(String(rows[0].name), 'Producto B');
});

test('INSERT en otra tienda es rechazado por RLS', async () => {
  const sql = platform.requirePlatformSql();
  await assert.rejects(
    async () =>
      sql.transaction([
        sql`SET LOCAL ROLE umantai_tenant`,
        sql`SELECT set_config('app.store_id', ${storeA}, true)`,
        sql`
          INSERT INTO store_products (store_id, slug, name, price_cents)
          VALUES (${storeB}::uuid, 'intruso', 'Intruso', 100)
        `,
      ]),
    (error: unknown) => code(error) === '42501',
  );
});

test('DELETE de order_items de otra tienda afecta 0 filas', async () => {
  const sql = platform.requirePlatformSql();
  const [, , deleted] = await sql.transaction([
    sql`SET LOCAL ROLE umantai_tenant`,
    sql`SELECT set_config('app.store_id', ${storeA}, true)`,
    sql`DELETE FROM order_items WHERE order_id = ${orderB}::uuid RETURNING id`,
  ]);
  assert.equal(deleted.length, 0);
});

test('el dueño del schema (rol de la app) no queda bloqueado', async () => {
  const sql = platform.requirePlatformSql();
  const rows = await sql`SELECT count(*)::int AS n FROM store_products`;
  assert.equal(Number(rows[0].n), 2);
});

test('el rol tenant existe y no puede saltar RLS', async () => {
  const sql = platform.requirePlatformSql();
  const rows = await sql`
    SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'umantai_tenant'
  `;
  assert.equal(rows.length, 1, 'falta el rol umantai_tenant');
  assert.equal(rows[0].rolbypassrls, false);
  assert.equal(rows[0].rolsuper, false);
});

test('las policies están activas en las 8 tablas', async () => {
  const sql = platform.requirePlatformSql();
  const rows = await sql`
    SELECT c.relname AS table_name, c.relrowsecurity AS enabled, count(p.polname)::int AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relname IN ('store_products', 'product_variants', 'inventory',
                          'inventory_movements', 'orders', 'order_items',
                          'store_subscriptions', 'promotion_redemptions')
     GROUP BY c.relname, c.relrowsecurity
  `;
  assert.equal(rows.length, TABLES.length);
  for (const row of rows) {
    assert.equal(row.enabled, true, `${row.table_name} sin RLS`);
    assert.ok(Number(row.policies) >= 1, `${row.table_name} sin policy`);
  }
});
