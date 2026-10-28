#!/usr/bin/env node
/**
 * scripts/cleanup-domain-test-data.mjs — borrado PUNTUAL de lo que dejó la prueba
 * privada de `umantai.com` sobre Railway staging (2026-10-27).
 *
 * Uso:
 *   APP_ENV=staging node scripts/cleanup-domain-test-data.mjs             # dry-run
 *   APP_ENV=staging node scripts/cleanup-domain-test-data.mjs --confirm   # ejecuta
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE ESTE SCRIPT Y NO ALCANZA `cleanup-smoke-data.ts`
 *
 *  Ese script borra por PATRONES (`%@umantai.test`, tiendas `e2e-%`/`smoke-%`,
 *  `metadata.smoke`). Los datos de esta prueba no entran en ningún patrón: hay
 *  una cuenta de Gmail con alias, una tienda `prueba-dominio-e2e`, un reclamo del
 *  Libro de Reclamaciones y un mensaje de contacto. Acá se listan por
 *  IDENTIFICADOR EXACTO y no se toca nada más.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLAS DE SEGURIDAD
 *
 *   1. `APP_ENV` debe ser `staging` o `test`. Cualquier otro valor (o vacío)
 *      aborta antes de conectar: Producción está bloqueada por construcción.
 *   2. Dry-run por defecto: sin `--confirm` no se borra nada.
 *   3. Una sola transacción: si algo falla, ROLLBACK y no queda nada a medias.
 *   4. Cada identificador debe resolver a UNA fila como máximo; si un
 *      identificador devuelve más de una, aborta (un ID equivocado no borra otra
 *      cosa).
 *   5. La reserva del pedido se libera con el MOTOR del ledger
 *      (`inventory_release_order`), nunca con UPDATE a mano, para que el stock
 *      del comercio vuelva a su lugar.
 *   6. El ledger es append-only: su trigger se desactiva y se vuelve a activar
 *      DENTRO de la misma transacción.
 *   7. El borrado nunca "adivina": no hay LIKE, ni rangos de fecha, ni filtros
 *      por estado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Client } from 'pg';

const CONFIRM = process.argv.includes('--confirm');
const APP_ENV = (process.env.APP_ENV ?? '').trim().toLowerCase();
const ALLOWED_ENVS = new Set(['staging', 'test']);

if (!ALLOWED_ENVS.has(APP_ENV)) {
  console.error(
    `[cleanup-domain] APP_ENV="${APP_ENV || '(vacío)'}". Este script SOLO corre con ` +
      'APP_ENV=staging o test; Producción está explícitamente bloqueada.',
  );
  process.exit(1);
}

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || '';
if (!connectionString) {
  console.error('[cleanup-domain] falta POSTGRES_URL_NON_POOLING / DATABASE_URL.');
  process.exit(1);
}

// ── Identificadores EXACTOS de la prueba (no editar sin revisar el runbook) ────
const ORDER_NUMBER = 'UM-2026-001055';
const ORDER_TOKEN = 'd5b57cd1-4ac8-480f-90bc-665a359c3291';
const COMPLAINT_CODE = '5VvZ3FnombOsFF8NePIBKN_T';
const STORE_SLUG = 'prueba-dominio-e2e';
const TEST_EMAILS = [
  'juancallerosales19+umantai-dns-test@gmail.com', // cuenta + mensaje de contacto
  'e2e-verify@umantai.test', // sonda de verificación/reset
  'e2e-dominio@umantai.test', // correo del pedido de prueba
].map((email) => email.toLowerCase());

// ── Helpers ──────────────────────────────────────────────────────────────────

const client = new Client({ connectionString, statement_timeout: 30_000 });

/** Enmascara el correo en la salida: el runbook no necesita el dato completo. */
function maskEmail(email) {
  return String(email).replace(/^(.{4})[^@]*(@.*)$/, '$1…$2');
}

async function main() {
  await client.connect();

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0] ?? null;

  // ── 1. Resolver los objetivos (solo lectura) ───────────────────────────────
  const order = await one(
    `SELECT id, order_number, status, store_id, contact_email, reservation_released, total
       FROM orders
      WHERE order_number = $1 AND public_token = $2`,
    [ORDER_NUMBER, ORDER_TOKEN],
  );
  const orderMatches = await one(
    `SELECT count(*)::int AS n FROM orders WHERE order_number = $1`,
    [ORDER_NUMBER],
  );

  const complaint = await one(
    `SELECT id, complaint_number, public_code, consumer_email
       FROM consumer_complaints WHERE public_code = $1`,
    [COMPLAINT_CODE],
  );

  const store = await one(`SELECT id, slug, active FROM stores WHERE lower(slug) = $1`, [
    STORE_SLUG,
  ]);

  const users = await q(`SELECT id, email FROM users WHERE lower(email) = ANY($1::text[])`, [
    TEST_EMAILS,
  ]);
  const userIds = users.map((row) => String(row.id));

  const contactMessages = await q(`SELECT id FROM contact_messages WHERE lower(email) = ANY($1::text[])`, [
    TEST_EMAILS,
  ]);
  const outbox = await one(`SELECT count(*)::int AS n FROM email_outbox WHERE lower(recipient) = ANY($1::text[])`, [
    TEST_EMAILS,
  ]);

  const orderItems = order
    ? await one(`SELECT count(*)::int AS n FROM order_items WHERE order_id = $1`, [order.id])
    : { n: 0 };
  const movements = await one(
    `SELECT count(*)::int AS n
       FROM inventory_movements
      WHERE ($1::uuid IS NOT NULL AND order_id = $1::uuid)
         OR ($2::uuid IS NOT NULL AND store_id = $2::uuid)`,
    [order?.id ?? null, store?.id ?? null],
  );
  const storeProducts = store
    ? await one(`SELECT count(*)::int AS n FROM store_products WHERE store_id = $1`, [store.id])
    : { n: 0 };
  const storeInventory = store
    ? await one(`SELECT count(*)::int AS n FROM inventory WHERE store_id = $1`, [store.id])
    : { n: 0 };
  const sessions = userIds.length
    ? await one(`SELECT count(*)::int AS n FROM sessions WHERE "userId" = ANY($1::text[])`, [userIds])
    : { n: 0 };

  // Reserva viva del pedido (si aún no venció): la reporta el propio motor.
  const held = order
    ? await q(
        `SELECT i.product_slug, i.variant_key, i.quantity_reserved
           FROM inventory i
          WHERE i.store_id = $1
            AND EXISTS (
              SELECT 1 FROM inventory_movements m
               WHERE m.order_id = $2 AND m.movement_type = 'reservation'
                 AND NOT EXISTS (
                   SELECT 1 FROM inventory_movements r
                    WHERE r.order_item_id = m.order_item_id
                      AND r.movement_type IN ('reservation_release', 'sale')
                 )
            )`,
        [order.store_id, order.id],
      )
    : [];

  // ── 2. Reporte del plan ────────────────────────────────────────────────────
  console.log('[cleanup-domain] APP_ENV:', APP_ENV);
  console.log('[cleanup-domain] objetivos:');
  console.log(
    `  pedido    ${ORDER_NUMBER}: ${order ? `1 fila (${order.status}, ${order.total} PEN)` : 'no existe'}` +
      ` · líneas ${orderItems.n} · movimientos del ledger que lo referencian: ${movements.n}`,
  );
  console.log(
    `  reclamo   ${COMPLAINT_CODE}: ${complaint ? `RC-${String(complaint.complaint_number).padStart(6, '0')}` : 'no existe'}`,
  );
  console.log(
    `  mensajes de contacto: ${contactMessages.length} · correos en email_outbox: ${outbox.n}`,
  );
  console.log(
    `  cuentas: ${users.length ? users.map((u) => maskEmail(u.email)).join(', ') : 'ninguna'}` +
      ` · sesiones ${sessions.n}`,
  );
  console.log(
    `  tienda    ${STORE_SLUG}: ${store ? '1 fila' : 'no existe'}` +
      ` · productos ${storeProducts.n} · inventario ${storeInventory.n}`,
  );
  if (held.length > 0) {
    console.log(
      `  reserva de stock aún retenida en ${held.length} SKU (se libera con inventory_release_order antes de borrar)`,
    );
  }

  // ── 3. Guardas de ambigüedad ──────────────────────────────────────────────
  if (orderMatches.n > 1) {
    console.error(
      `[cleanup-domain] ABORTA: ${orderMatches.n} pedidos con el número ${ORDER_NUMBER}.`,
    );
    process.exitCode = 1;
    return;
  }
  if (users.length > TEST_EMAILS.length) {
    console.error('[cleanup-domain] ABORTA: más cuentas que correos de prueba definidos.');
    process.exitCode = 1;
    return;
  }
  if (!order && !complaint && users.length === 0 && !store && contactMessages.length === 0) {
    console.log('[cleanup-domain] nada que borrar: los datos de la prueba ya no están.');
    return;
  }

  if (!CONFIRM) {
    console.log('[cleanup-domain] DRY-RUN: no se borró nada. Agrega --confirm para ejecutar.');
    return;
  }

  // ── 4. Borrado (una sola transacción) ─────────────────────────────────────
  await client.query('BEGIN');
  try {
    // 4.1 Devolver el stock del comercio ANTES de borrar el pedido.
    if (order) {
      const released = await client.query(`SELECT inventory_release_order($1, $2) AS lines`, [
        order.id,
        'qa_cleanup',
      ]);
      console.log(
        `[cleanup-domain] reserva liberada por el motor: ${released.rows[0]?.lines ?? 0} línea(s)`,
      );
    }

    // 4.2 Escape hatch documentado: permite borrar líneas de un pedido ya no
    //     `pending_payment` (guard_order_items_mutation). Auditable y local a la
    //     transacción.
    await client.query(`SET LOCAL app.allow_line_edits = 'on'`);

    // 4.3 El ledger es append-only: se desactiva su trigger y se reactiva abajo,
    //     en la MISMA transacción (`ON DELETE RESTRICT` obliga a borrar los
    //     movimientos antes que el pedido).
    await client.query(
      'ALTER TABLE inventory_movements DISABLE TRIGGER trg_inventory_movements_append_only',
    );

    const deletedMovements = await client.query(
      `DELETE FROM inventory_movements
        WHERE ($1::uuid IS NOT NULL AND order_id = $1::uuid)
           OR ($2::uuid IS NOT NULL AND store_id = $2::uuid)`,
      [order?.id ?? null, store?.id ?? null],
    );
    const deletedOrders = order
      ? await client.query('DELETE FROM orders WHERE id = $1 AND public_token = $2', [
          order.id,
          ORDER_TOKEN,
        ])
      : { rowCount: 0 };
    const deletedComplaints = await client.query(
      'DELETE FROM consumer_complaints WHERE public_code = $1',
      [COMPLAINT_CODE],
    );
    const deletedContacts = await client.query(
      'DELETE FROM contact_messages WHERE lower(email) = ANY($1::text[])',
      [TEST_EMAILS],
    );
    const deletedOutbox = await client.query(
      'DELETE FROM email_outbox WHERE lower(recipient) = ANY($1::text[])',
      [TEST_EMAILS],
    );
    const deletedSessions = await client.query(
      `DELETE FROM sessions WHERE "userId" = ANY($1::text[])`,
      [userIds],
    );
    const deletedVerifications = await client.query(
      `DELETE FROM verifications WHERE lower(value) = ANY($1::text[]) OR lower(identifier) = ANY($1::text[])`,
      [...TEST_EMAILS, ...userIds.map((id) => id.toLowerCase())],
    );
    const deletedStoreProducts = store
      ? await client.query('DELETE FROM store_products WHERE store_id = $1', [store.id])
      : { rowCount: 0 };
    const deletedInventory = store
      ? await client.query('DELETE FROM inventory WHERE store_id = $1', [store.id])
      : { rowCount: 0 };
    const deletedStores = store
      ? await client.query('DELETE FROM stores WHERE id = $1 AND lower(slug) = $2', [
          store.id,
          STORE_SLUG,
        ])
      : { rowCount: 0 };
    // Las cuentas al final: sessions, auth_accounts, customer_profiles,
    // store_members y platform_admins cuelgan con ON DELETE CASCADE.
    const deletedUsers = await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds]);

    await client.query(
      'ALTER TABLE inventory_movements ENABLE TRIGGER trg_inventory_movements_append_only',
    );
    await client.query('COMMIT');

    console.log('[cleanup-domain] borrado:', {
      movimientos: deletedMovements.rowCount,
      pedidos: deletedOrders.rowCount,
      reclamos: deletedComplaints.rowCount,
      mensajesDeContacto: deletedContacts.rowCount,
      correos: deletedOutbox.rowCount,
      sesiones: deletedSessions.rowCount,
      verificaciones: deletedVerifications.rowCount,
      productosDeTienda: deletedStoreProducts.rowCount,
      inventario: deletedInventory.rowCount,
      tiendas: deletedStores.rowCount,
      cuentas: deletedUsers.rowCount,
    });

    // 4.4 Comprobación final: los identificadores ya no existen y el trigger
    //     del ledger quedó activo.
    const after = await one(
      `SELECT
         (SELECT count(*)::int FROM orders WHERE order_number = $1) AS orders,
         (SELECT count(*)::int FROM consumer_complaints WHERE public_code = $2) AS complaints,
         (SELECT count(*)::int FROM stores WHERE lower(slug) = $3) AS stores,
         (SELECT count(*)::int FROM users WHERE lower(email) = ANY($4::text[])) AS users,
         (SELECT count(*)::int FROM contact_messages WHERE lower(email) = ANY($4::text[])) AS contacts,
         (SELECT count(*)::int FROM email_outbox WHERE lower(recipient) = ANY($4::text[])) AS outbox,
         (SELECT count(*)::int FROM pg_trigger
           WHERE tgname = 'trg_inventory_movements_append_only' AND NOT tgisinternal
             AND tgenabled <> 'D') AS ledger_trigger_enabled`,
      [ORDER_NUMBER, COMPLAINT_CODE, STORE_SLUG, TEST_EMAILS],
    );
    console.log('[cleanup-domain] verificación:', after);
    const clean =
      after.orders === 0 &&
      after.complaints === 0 &&
      after.stores === 0 &&
      after.users === 0 &&
      after.contacts === 0 &&
      Number(after.ledger_trigger_enabled) === 1;
    console.log(`[cleanup-domain] ${clean ? '✔ limpio' : '✘ revisar'}`);
    process.exitCode = clean ? 0 : 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      '[cleanup-domain] falló; transacción revertida:',
      error instanceof Error ? error.message : 'unknown',
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
