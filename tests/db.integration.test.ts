/**
 * tests/db.integration.test.ts — integración REAL contra PostgreSQL 17.
 *
 * Levanta un cluster efímero en localhost, aplica las migraciones 001–007 y
 * ejercita el motor completo a través de `lib/commerce.server.ts` con el driver
 * `pg` (el mismo que usará Railway).
 *
 * NUNCA toca Producción, Preview ni QA: no lee DATABASE_URL ni ninguna URL
 * externa; el helper crea su propio cluster temporal.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import { startEmbeddedPostgres, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type Commerce = typeof import('../lib/commerce.server');
type Confirmation = typeof import('../lib/payment-confirmation.server');

let database: EmbeddedTestDatabase;
let commerce: Commerce;
let confirmation: Confirmation;

// =============================================================================
//  SETUP
// =============================================================================

before(async () => {
  database = await startEmbeddedPostgres();

  // Debe quedar ANTES de importar lib/env.ts / commerce.server.ts.
  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  delete process.env.VERCEL_ENV;
  delete process.env.RESEND_API_KEY;

  commerce = await import('../lib/commerce.server');
  confirmation = await import('../lib/payment-confirmation.server');
});

after(async () => {
  await closeDbPools();
  if (database) await database.stop();
});

// =============================================================================
//  HELPERS
// =============================================================================

async function seedProduct(slug: string, quantity: number): Promise<void> {
  await commerce.applyInventoryMovement({
    productSlug: slug,
    variantKey: '',
    movementType: 'receipt',
    onHandDelta: quantity,
    reason: 'integration_seed',
    performedBy: 'test',
    idempotencyKey: `seed-${slug}-${randomUUID()}`,
  });
}

function orderInput(slug: string, quantity = 2, idempotencyKey = `it-${randomUUID()}`) {
  return {
    idempotencyKey,
    contactEmail: 'integration@example.invalid',
    fulfillmentType: 'pickup_locker' as const,
    items: [
      {
        productSlug: slug,
        productName: `Integration ${slug}`,
        variant: {},
        quantity,
        unitPrice: 10,
      },
    ],
  };
}

async function createOrder(slug: string, quantity = 2, idempotencyKey?: string) {
  return commerce.createOrder(orderInput(slug, quantity, idempotencyKey));
}

async function pay(
  order: Awaited<ReturnType<Commerce['createOrder']>>,
  paymentId = `SIMULATED-MP-${order.id}`,
) {
  const result = await confirmation.applyApprovedPayment({
    paymentId,
    orderNumber: order.orderNumber,
    paymentMethod: 'qa_simulation',
    paidAmount: order.total,
    currency: order.currency,
    source: 'simulation',
  });
  assert.ok(result, 'applyApprovedPayment devolvió null');
  return result;
}

async function inventory(slug: string) {
  const item = await commerce.getInventoryItem(slug, '', 'MAIN');
  assert.ok(item, `falta inventario para ${slug}`);
  return item;
}

// =============================================================================
//  1. PEDIDO + RESERVA DE STOCK
// =============================================================================

test('crear pedido reserva stock y nace pendiente de pago', async () => {
  const slug = 'it-create';
  await seedProduct(slug, 10);

  const order = await createOrder(slug, 2);

  assert.equal(order.status, 'pending_payment');
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(order.itemCount, 2);
  assert.equal(order.total, 20);
  assert.equal(order.items.length, 1);

  const stock = await inventory(slug);
  assert.equal(stock.quantityOnHand, 10);
  assert.equal(stock.quantityReserved, 2);
  assert.equal(stock.quantityAvailable, 8);
});

// =============================================================================
//  2. IDEMPOTENCIA DE CREACIÓN
// =============================================================================

test('la misma idempotencyKey devuelve el mismo pedido sin duplicar stock', async () => {
  const slug = 'it-idem';
  await seedProduct(slug, 10);
  const key = `it-idem-${randomUUID()}`;

  const first = await createOrder(slug, 1, key);
  const second = await createOrder(slug, 1, key);

  assert.equal(second.id, first.id);
  assert.equal(second.orderNumber, first.orderNumber);

  const stock = await inventory(slug);
  assert.equal(stock.quantityReserved, 1);
});

// =============================================================================
//  3. CANCELACIÓN LIBERA STOCK
// =============================================================================

test('cancelar libera la reserva y deja el pedido cancelled', async () => {
  const slug = 'it-cancel';
  await seedProduct(slug, 5);

  const order = await createOrder(slug, 3);
  assert.equal((await inventory(slug)).quantityReserved, 3);

  const cancelled = await commerce.cancelOrder(order.id, { reason: 'integration_test' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledReason, 'integration_test');

  const stock = await inventory(slug);
  assert.equal(stock.quantityReserved, 0);
  assert.equal(stock.quantityOnHand, 5);
  assert.equal(stock.quantityAvailable, 5);
});

// =============================================================================
//  4. CONFIRMACIÓN DE PAGO SIMULADO
// =============================================================================

test('el pago simulado confirma el pedido y conserva la reserva', async () => {
  const slug = 'it-pay';
  await seedProduct(slug, 5);

  const order = await createOrder(slug, 2);
  const paymentId = `SIMULATED-MP-${order.id}`;
  const result = await pay(order, paymentId);

  assert.equal(result.order.status, 'confirmed');
  assert.equal(result.order.paymentStatus, 'paid');
  assert.equal(result.order.paymentReference, paymentId);
  assert.equal(result.audit?.lastPaymentId, paymentId);
  assert.equal(result.fulfillmentBlocked, false);
});

test('reintentar el MISMO pago es idempotente y no marca duplicado', async () => {
  const slug = 'it-pay-idem';
  await seedProduct(slug, 5);

  const order = await createOrder(slug, 1);
  const paymentId = `SIMULATED-MP-${order.id}`;

  await pay(order, paymentId);
  const again = await pay(order, paymentId);

  assert.equal(again.order.status, 'confirmed');
  assert.equal(again.audit?.duplicatePayment, false);
  assert.equal(again.audit?.receivedPaymentIds.length, 1);
});

// =============================================================================
//  5. GUARDA DE PAGO DUPLICADO (migración 005)
// =============================================================================

test('un segundo pago distinto marca duplicatePayment y no sobrescribe la referencia', async () => {
  const slug = 'it-duplicate';
  await seedProduct(slug, 5);

  const order = await createOrder(slug, 1);
  const firstPayment = `SIMULATED-MP-${order.id}-A`;
  const secondPayment = `SIMULATED-MP-${order.id}-B`;

  await pay(order, firstPayment);
  const second = await pay(order, secondPayment);

  assert.equal(second.order.status, 'confirmed');
  assert.equal(second.order.paymentStatus, 'paid');
  assert.equal(second.order.paymentReference, firstPayment);
  assert.equal(second.audit?.duplicatePayment, true);
  assert.equal(second.audit?.needsReview, true);
  assert.equal(second.fulfillmentBlocked, true);
});

// =============================================================================
//  6. PIN + PICKUP (commit de stock)
// =============================================================================

test('preparar emite un PIN de 6 dígitos y retirar consolida el stock', async () => {
  const slug = 'it-pickup';
  await seedProduct(slug, 10);

  const order = await createOrder(slug, 2);
  await pay(order);

  const code = await commerce.markReadyForPickup(order.id, {
    lockerCode: 'MAIN',
    lockerSlot: 'A-1',
    actor: 'test',
  });

  assert.match(code.code, /^[0-9]{6}$/);
  assert.equal(code.status, 'issued');

  const ready = await commerce.getOrderWithItems(order.id);
  assert.equal(ready?.status, 'ready_for_pickup');

  const redeemed = await commerce.redeemPickupCode({
    code: code.code,
    redeemedBy: 'kiosk:integration',
    deviceId: 'it-device',
    ip: '127.0.0.1',
  });

  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.committed_lines, 1);

  const finalOrder = await commerce.getOrderWithItems(order.id);
  assert.equal(finalOrder?.status, 'picked_up');
  assert.equal(finalOrder?.paymentStatus, 'paid');

  const stock = await inventory(slug);
  assert.equal(stock.quantityOnHand, 8);
  assert.equal(stock.quantityReserved, 0);
  assert.equal(stock.quantityAvailable, 8);
});

test('un PIN inexistente no entrega ni descuenta stock', async () => {
  const slug = 'it-pin-bad';
  await seedProduct(slug, 4);

  const order = await createOrder(slug, 1);
  await pay(order);
  const code = await commerce.markReadyForPickup(order.id, { lockerCode: 'MAIN' });

  const wrong = code.code === '000000' ? '111111' : '000000';
  const redeemed = await commerce.redeemPickupCode({
    code: wrong,
    redeemedBy: 'kiosk:integration',
    deviceId: 'it-device',
    ip: '127.0.0.1',
  });

  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.committed_lines, 0);

  const stillReady = await commerce.getOrderWithItems(order.id);
  assert.equal(stillReady?.status, 'ready_for_pickup');

  const stock = await inventory(slug);
  assert.equal(stock.quantityOnHand, 4);
  assert.equal(stock.quantityReserved, 1);
});
