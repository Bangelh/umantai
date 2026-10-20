/**
 * scripts/cleanup-smoke-data.ts — borra SOLO datos demo/smoke etiquetados.
 *
 * Uso:
 *   APP_ENV=staging node --import tsx scripts/cleanup-smoke-data.ts            # dry-run
 *   APP_ENV=staging node --import tsx scripts/cleanup-smoke-data.ts --confirm  # ejecuta
 *
 * Reglas de seguridad:
 *   · APP_ENV debe ser staging o test (fail-closed con cualquier otro valor).
 *   · Sólo considera etiquetados explícitos:
 *       - usuarios  con correo @umantai.test o @example.invalid
 *       - tiendas   con slug `e2e-…`, `smoke-…` o metadata.smoke = true
 *       - pedidos   de esas tiendas/correos o metadata.smoke = true
 *       - email_outbox de esos correos
 *   · Dry-run por defecto: sin `--confirm` no borra nada.
 *   · Una transacción: si algo falla, no queda a medias.
 *   · Nunca toca Producción: no se puede ni pasar el gate.
 */

import { Client } from 'pg';

import { getDatabaseUrl } from '../lib/db';

const APP_ENV = (process.env.APP_ENV ?? '').trim().toLowerCase();
const CONFIRM = process.argv.includes('--confirm');
const ALLOWED = new Set(['staging', 'test']);

function abort(message: string): never {
  console.error(`[cleanup] ${message}`);
  process.exit(1);
}

if (!ALLOWED.has(APP_ENV)) {
  abort(
    `APP_ENV="${APP_ENV || '(vacío)'}". Este script SOLO corre con APP_ENV=staging o test. ` +
      'Producción está explícitamente bloqueada.',
  );
}

const url = getDatabaseUrl();
if (!url) abort('Falta la URL de PostgreSQL.');

const EMAIL_PATTERN = `(lower(u.email) LIKE '%@umantai.test' OR lower(u.email) LIKE '%@example.invalid')`;

const client = new Client({ connectionString: url });

interface Counts {
  users: number;
  stores: number;
  orders: number;
  orderItems: number;
  inventory: number;
  movements: number;
  outbox: number;
}

async function countAll(): Promise<Counts> {
  const users = await client.query(
    `SELECT count(*)::int AS n FROM users u WHERE ${EMAIL_PATTERN}`,
  );
  const stores = await client.query(
    `SELECT count(*)::int AS n FROM stores s
      WHERE lower(s.slug) LIKE 'e2e-%'
         OR lower(s.slug) LIKE 'smoke-%'
         OR s.metadata->>'smoke' = 'true'`,
  );
  const orders = await client.query(
    `SELECT count(*)::int AS n FROM orders o
      WHERE o.metadata->>'smoke' = 'true'
         OR lower(o.contact_email) LIKE '%@umantai.test'
         OR lower(o.contact_email) LIKE '%@example.invalid'
         OR o.store_id IN (
              SELECT s.id FROM stores s
               WHERE lower(s.slug) LIKE 'e2e-%'
                  OR lower(s.slug) LIKE 'smoke-%'
                  OR s.metadata->>'smoke' = 'true'
            )`,
  );
  const orderItems = await client.query(
    `SELECT count(*)::int AS n FROM order_items oi
      WHERE oi.order_id IN (
              SELECT o.id FROM orders o
               WHERE o.metadata->>'smoke' = 'true'
                  OR lower(o.contact_email) LIKE '%@umantai.test'
                  OR lower(o.contact_email) LIKE '%@example.invalid'
                  OR o.store_id IN (
                       SELECT s.id FROM stores s
                        WHERE lower(s.slug) LIKE 'e2e-%'
                           OR lower(s.slug) LIKE 'smoke-%'
                           OR s.metadata->>'smoke' = 'true'
                     )
            )`,
  );
  const inventory = await client.query(
    `SELECT count(*)::int AS n FROM inventory i
      WHERE i.store_id IN (
              SELECT s.id FROM stores s
               WHERE lower(s.slug) LIKE 'e2e-%'
                  OR lower(s.slug) LIKE 'smoke-%'
                  OR s.metadata->>'smoke' = 'true'
            )`,
  );
  const movements = await client.query(
    `SELECT count(*)::int AS n FROM inventory_movements m
      WHERE m.store_id IN (
              SELECT s.id FROM stores s
               WHERE lower(s.slug) LIKE 'e2e-%'
                  OR lower(s.slug) LIKE 'smoke-%'
                  OR s.metadata->>'smoke' = 'true'
            )
         OR m.order_id IN (
              SELECT o.id FROM orders o
               WHERE o.metadata->>'smoke' = 'true'
                  OR lower(o.contact_email) LIKE '%@umantai.test'
                  OR lower(o.contact_email) LIKE '%@example.invalid'
            )`,
  );
  const outbox = await client.query(
    `SELECT count(*)::int AS n FROM email_outbox e
      WHERE lower(e.recipient) LIKE '%@umantai.test'
         OR lower(e.recipient) LIKE '%@example.invalid'`,
  );

  return {
    users: Number(users.rows[0].n),
    stores: Number(stores.rows[0].n),
    orders: Number(orders.rows[0].n),
    orderItems: Number(orderItems.rows[0].n),
    inventory: Number(inventory.rows[0].n),
    movements: Number(movements.rows[0].n),
    outbox: Number(outbox.rows[0].n),
  };
}

async function main() {
  await client.connect();
  try {
    const before = await countAll();
    console.info('[cleanup] APP_ENV:', APP_ENV);
    console.info('[cleanup] etiquetados encontrados:', before);

    if (!CONFIRM) {
      console.info('[cleanup] DRY-RUN: no se borró nada. Agrega --confirm para ejecutar.');
      return;
    }

    await client.query('BEGIN');

    // El ledger es append-only: se desactiva su trigger SOLO dentro de esta
    // transacción y sólo para filas smoke. Si algo falla, el ROLLBACK lo deja todo.
    await client.query('ALTER TABLE inventory_movements DISABLE TRIGGER trg_inventory_movements_append_only');

    const movements = await client.query(
      `DELETE FROM inventory_movements m
        WHERE m.store_id IN (
                SELECT s.id FROM stores s
                 WHERE lower(s.slug) LIKE 'e2e-%'
                    OR lower(s.slug) LIKE 'smoke-%'
                    OR s.metadata->>'smoke' = 'true'
              )
           OR m.order_id IN (
                SELECT o.id FROM orders o
                 WHERE o.metadata->>'smoke' = 'true'
                    OR lower(o.contact_email) LIKE '%@umantai.test'
                    OR lower(o.contact_email) LIKE '%@example.invalid'
              )`,
    );

    const orders = await client.query(
      `DELETE FROM orders o
        WHERE o.metadata->>'smoke' = 'true'
           OR lower(o.contact_email) LIKE '%@umantai.test'
           OR lower(o.contact_email) LIKE '%@example.invalid'
           OR o.store_id IN (
                SELECT s.id FROM stores s
                 WHERE lower(s.slug) LIKE 'e2e-%'
                    OR lower(s.slug) LIKE 'smoke-%'
                    OR s.metadata->>'smoke' = 'true'
              )`,
    );

    // `inventory` referencia stores con ON DELETE RESTRICT: sin esta fila el
    // borrado de la tienda falla aunque el resto de dependencias sean CASCADE.
    const inventory = await client.query(
      `DELETE FROM inventory i
        WHERE i.store_id IN (
                SELECT s.id FROM stores s
                 WHERE lower(s.slug) LIKE 'e2e-%'
                    OR lower(s.slug) LIKE 'smoke-%'
                    OR s.metadata->>'smoke' = 'true'
              )`,
    );

    const stores = await client.query(
      `DELETE FROM stores s
        WHERE lower(s.slug) LIKE 'e2e-%'
           OR lower(s.slug) LIKE 'smoke-%'
           OR s.metadata->>'smoke' = 'true'`,
    );

    const users = await client.query(
      `DELETE FROM users u WHERE ${EMAIL_PATTERN}`,
    );

    const outbox = await client.query(
      `DELETE FROM email_outbox e
        WHERE lower(e.recipient) LIKE '%@umantai.test'
           OR lower(e.recipient) LIKE '%@example.invalid'`,
    );

    await client.query('ALTER TABLE inventory_movements ENABLE TRIGGER trg_inventory_movements_append_only');
    await client.query('COMMIT');

    console.info('[cleanup] borrado:', {
      inventory: inventory.rowCount,
      movements: movements.rowCount,
      orders: orders.rowCount,
      stores: stores.rowCount,
      users: users.rowCount,
      outbox: outbox.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      '[cleanup] falló; transacción revertida:',
      error instanceof Error ? error.message : 'unknown',
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
