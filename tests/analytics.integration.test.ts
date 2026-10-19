/**
 * tests/analytics.integration.test.ts — analytics contra PostgreSQL real.
 *
 * Usa el mismo helper efímero que `db.integration.test.ts` (nunca Producción).
 * Lo que se verifica:
 *   · la regla de venta con pedidos reales (pendiente / cancelado / reembolsado
 *     no suman; pagado sí);
 *   · los montos en centavos sin error de float;
 *   · los límites del día comercial de Lima (un pedido de las 22:00 de Lima cae
 *     en el día correcto aunque en UTC ya sea el día siguiente);
 *   · top productos, estados y stock bajo/agotado.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools, createSqlClient, type SqlClient } from '../lib/db-driver.server';
import { resolveAnalyticsRange } from '../lib/analytics';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type Commerce = typeof import('../lib/commerce.server');
type Analytics = typeof import('../lib/analytics.server');
type Confirmation = typeof import('../lib/payment-confirmation.server');

let database: EmbeddedTestDatabase;
let commerce: Commerce;
let analytics: Analytics;
let confirmation: Confirmation;
let sql: SqlClient;

before(async () => {
  database = await startTestDatabase();
  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  if (database.external) console.info('[analytics-integration] usando INTEGRATION_DATABASE_URL');

  commerce = await import('../lib/commerce.server');
  analytics = await import('../lib/analytics.server');
  confirmation = await import('../lib/payment-confirmation.server');
  sql = createSqlClient(database.url);
});

after(async () => {
  await closeDbPools();
  if (database) await database.stop();
});

async function seed(slug: string, quantity: number): Promise<void> {
  await commerce.applyInventoryMovement({
    productSlug: slug,
    variantKey: '',
    movementType: 'receipt',
    onHandDelta: quantity,
    reason: 'analytics_it_seed',
    performedBy: 'test',
    idempotencyKey: `analytics-seed-${slug}-${randomUUID()}`,
  });
}

async function createAndPay(
  slug: string,
  unitPrice: number,
  quantity: number,
): Promise<Awaited<ReturnType<Commerce['createOrder']>>> {
  const order = await commerce.createOrder({
    idempotencyKey: `analytics-it-${randomUUID()}`,
    contactEmail: 'analytics@example.invalid',
    fulfillmentType: 'pickup_counter',
    items: [
      {
        productSlug: slug,
        productName: `Analytics ${slug}`,
        variant: {},
        quantity,
        unitPrice,
      },
    ],
  });

  const result = await confirmation.applyApprovedPayment({
    paymentId: `ANALYTICS-${order.id}`,
    orderNumber: order.orderNumber,
    paymentMethod: 'qa_simulation',
    paidAmount: order.total,
    currency: order.currency,
    source: 'simulation',
  });
  assert.ok(result, 'el pago simulado no confirmó el pedido');
  return order;
}

async function setCreatedAt(orderId: string, iso: string): Promise<void> {
  await sql`UPDATE orders SET created_at = ${iso}::timestamptz WHERE id = ${orderId}::uuid`;
}

async function summaryFor(from: string, to: string) {
  const range = resolveAnalyticsRange({ preset: 'custom', from, to });
  assert.ok(range.ok, 'el rango de prueba debería ser válido');
  return analytics.getAnalyticsSummary({ range: range.range, previous: range.previous });
}

// =============================================================================
//  REGLA DE VENTA + KPIs
// =============================================================================

test('solo los pedidos pagados cuentan como venta (centavos exactos)', async () => {
  await seed('it-analytics-sales', 20);

  const paid = await createAndPay('it-analytics-sales', 10.5, 2);
  await setCreatedAt(paid.id, '2026-10-19T15:00:00.000Z'); // 10:00 Lima

  // Pendiente de pago: reserva stock, no es venta.
  const pending = await commerce.createOrder({
    idempotencyKey: `analytics-pending-${randomUUID()}`,
    contactEmail: 'pending@example.invalid',
    fulfillmentType: 'pickup_counter',
    items: [
      { productSlug: 'it-analytics-sales', productName: 'Pendiente', variant: {}, quantity: 1, unitPrice: 99 },
    ],
  });
  await setCreatedAt(pending.id, '2026-10-19T16:00:00.000Z');

  // Cancelado.
  const cancelled = await commerce.createOrder({
    idempotencyKey: `analytics-cancelled-${randomUUID()}`,
    contactEmail: 'cancelled@example.invalid',
    fulfillmentType: 'pickup_counter',
    items: [
      { productSlug: 'it-analytics-sales', productName: 'Cancelado', variant: {}, quantity: 1, unitPrice: 50 },
    ],
  });
  await sql`UPDATE orders SET status = 'cancelled' WHERE id = ${cancelled.id}::uuid`;
  await setCreatedAt(cancelled.id, '2026-10-19T17:00:00.000Z');

  // Reembolsado: fue pagado, pero el dinero volvió.
  const refunded = await createAndPay('it-analytics-sales', 5, 1);
  await sql`UPDATE orders SET status = 'refunded', payment_status = 'refunded' WHERE id = ${refunded.id}::uuid`;
  await setCreatedAt(refunded.id, '2026-10-19T18:00:00.000Z');

  const summary = await summaryFor('2026-10-19', '2026-10-19');

  assert.equal(summary.sales.orders, 1, 'solo el pedido pagado cuenta');
  assert.equal(summary.sales.revenueCents, 2100, '2 × 10.50 = 21.00 → 2100 centavos');
  assert.equal(summary.sales.averageTicketCents, 2100);
  assert.equal(summary.sales.itemsSold, 2);
  assert.equal(summary.sales.allOrders, 4);
  assert.equal(summary.sales.cancelledOrders, 1);

  assert.equal(summary.topProducts.length, 1);
  assert.equal(summary.topProducts[0].productSlug, 'it-analytics-sales');
  assert.equal(summary.topProducts[0].quantity, 2);
  assert.equal(summary.topProducts[0].revenueCents, 2100);

  const byStatus = new Map(summary.ordersByStatus.map((row) => [row.status, row.count]));
  assert.equal(byStatus.get('confirmed'), 1);
  assert.equal(byStatus.get('pending_payment'), 1);
  assert.equal(byStatus.get('cancelled'), 1);
  assert.equal(byStatus.get('refunded'), 1);

  // La serie diaria trae el día con datos y el resto en cero.
  assert.equal(summary.series.daily.length, 1);
  assert.equal(summary.series.daily[0].date, '2026-10-19');
  assert.equal(summary.series.daily[0].revenueCents, 2100);
});

// =============================================================================
//  TIMEZONE (LIMA)
// =============================================================================

test('el día comercial de Lima manda sobre UTC en los bordes', async () => {
  await seed('it-analytics-tz', 10);

  // 2026-11-11 03:00 UTC = 2026-11-10 22:00 en Lima → debe caer el 10.
  const late = await createAndPay('it-analytics-tz', 20, 1);
  await setCreatedAt(late.id, '2026-11-11T03:00:00.000Z');

  // 2026-11-11 05:00 UTC = 2026-11-11 00:00 en Lima → ya es el 11.
  const midnight = await createAndPay('it-analytics-tz', 30, 1);
  await setCreatedAt(midnight.id, '2026-11-11T05:00:00.000Z');

  const day10 = await summaryFor('2026-11-10', '2026-11-10');
  assert.equal(day10.sales.orders, 1);
  assert.equal(day10.sales.revenueCents, 2000, 'solo la venta de las 22:00 de Lima');
  assert.deepEqual(
    day10.series.daily.map((point) => point.date),
    ['2026-11-10'],
  );

  const day11 = await summaryFor('2026-11-11', '2026-11-11');
  assert.equal(day11.sales.orders, 1);
  assert.equal(day11.sales.revenueCents, 3000);
});

// =============================================================================
//  SERIES SEMANALES
// =============================================================================

test('la serie semanal agrupa por semana ISO desde el lunes', async () => {
  const summary = await summaryFor('2026-11-09', '2026-11-15');
  assert.equal(summary.series.weekly.length, 1);
  assert.equal(summary.series.weekly[0].date, '2026-11-09');
  assert.equal(summary.series.weekly[0].orders, 2); // 10 nov (22:00 Lima) + 11 nov
  assert.equal(summary.series.weekly[0].revenueCents, 5000);
});

// =============================================================================
//  STOCK
// =============================================================================

test('stock bajo y agotado salen de la foto actual del inventario', async () => {
  await seed('it-analytics-low', 2);
  await commerce.setReorderPoint('it-analytics-low', '', 5);

  // SKU con fila en cero: agotado (no tiene reorder point).
  await commerce.setReorderPoint('it-analytics-out', '', 0);

  const summary = await summaryFor('2026-10-19', '2026-10-19');

  const low = summary.lowStock.find((item) => item.productSlug === 'it-analytics-low');
  assert.ok(low, 'el SKU bajo mínimo debería aparecer');
  assert.equal(low.available, 2);
  assert.equal(low.reorderPoint, 5);

  const out = summary.outOfStock.find((item) => item.productSlug === 'it-analytics-out');
  assert.ok(out, 'el SKU en cero debería aparecer como agotado');
  assert.equal(out.available, 0);

  // Un SKU agotado no se duplica en la lista de "bajo stock".
  assert.ok(!summary.lowStock.some((item) => item.productSlug === 'it-analytics-out'));
});

// =============================================================================
//  RANGO VACÍO
// =============================================================================

test('un rango sin pedidos devuelve ceros y la serie completa, sin error', async () => {
  const summary = await summaryFor('2026-01-01', '2026-01-07');

  assert.equal(summary.sales.orders, 0);
  assert.equal(summary.sales.revenueCents, 0);
  assert.equal(summary.sales.averageTicketCents, 0);
  assert.equal(summary.sales.allOrders, 0);
  assert.equal(summary.change.revenuePct, null);
  assert.equal(summary.series.daily.length, 7);
  assert.ok(summary.series.daily.every((point) => point.revenueCents === 0));
  assert.equal(summary.topProducts.length, 0);
  assert.equal(summary.previous.from, '2025-12-25');
  assert.equal(summary.previous.to, '2025-12-31');
});
