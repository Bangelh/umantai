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
import { buildVariantKey } from '../lib/commerce';
import { inventoryStatusFor } from '../lib/inventory-admin';
import { findStockShortages } from '../lib/stock-conflict';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type Commerce = typeof import('../lib/commerce.server');
type Confirmation = typeof import('../lib/payment-confirmation.server');

let database: EmbeddedTestDatabase;
let commerce: Commerce;
let confirmation: Confirmation;
let inventoryAdmin: typeof import('../lib/inventory-admin.server');

// =============================================================================
//  SETUP
// =============================================================================

before(async () => {
  database = await startTestDatabase();

  // Debe quedar ANTES de importar lib/env.ts / commerce.server.ts.
  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  if (database.external) console.info('[integration] usando INTEGRATION_DATABASE_URL (staging/test DB)');
  process.env.APP_ENV = 'test';
  delete process.env.VERCEL_ENV;
  delete process.env.RESEND_API_KEY;

  commerce = await import('../lib/commerce.server');
  confirmation = await import('../lib/payment-confirmation.server');
  inventoryAdmin = await import('../lib/inventory-admin.server');
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

// =============================================================================
//  7. INVENTARIO ADMIN — ENTRADA, AJUSTE, UMBRAL Y LEDGER
// =============================================================================

test('entrada de mercadería crea movimiento, umbral y estado de stock bajo', async () => {
  const variantKey = buildVariantKey({ color: 'Stealth' });
  const receipt = await inventoryAdmin.executeReceipt({
    productSlug: 'oura-ring-gen3',
    variantKey,
    quantity: 6,
    reason: 'integration receipt',
    actor: 'it-admin',
    reorderPoint: 5,
    idempotencyKey: `it-receipt-${randomUUID()}`,
  });

  assert.equal(receipt.item.quantityOnHand, 6);
  assert.equal(receipt.item.quantityAvailable, 6);
  assert.equal(receipt.item.status, 'available');
  assert.equal(receipt.movement.movementType, 'receipt');
  assert.equal(receipt.movement.onHandDelta, 6);
  assert.equal(receipt.thresholdWarning, null);

  const lowAfterReceipt = await commerce.listLowStock();
  assert.equal(
    lowAfterReceipt.some((row) => row.productSlug === 'oura-ring-gen3' && row.variantKey === variantKey),
    false,
  );

  const ledger = await commerce.listInventoryLedger({
    productSlug: 'oura-ring-gen3',
    movementType: 'receipt',
    limit: 10,
  });
  assert.ok(ledger.entries.some((entry) => entry.id === receipt.movement.id));
});

test('ajuste positivo y negativo respeta el ledger y marca poco stock/agotado', async () => {
  const variantKey = buildVariantKey({ color: 'Stealth' });

  const decrease = await inventoryAdmin.executeAdjustment({
    productSlug: 'oura-ring-gen3',
    variantKey,
    delta: -3,
    reason: 'integration merma',
    actor: 'it-admin',
    idempotencyKey: `it-adjust-down-${randomUUID()}`,
  });

  assert.equal(decrease.before.onHand, 6);
  assert.equal(decrease.movement.onHandAfter, 3);
  assert.equal(decrease.movement.movementType, 'adjustment');
  assert.equal(inventoryStatusFor(decrease.item.quantityAvailable, decrease.item.reorderPoint), 'low');

  const lowStock = await commerce.listLowStock();
  assert.ok(
    lowStock.some((row) => row.productSlug === 'oura-ring-gen3' && row.variantKey === variantKey),
  );

  const empty = await inventoryAdmin.executeAdjustment({
    productSlug: 'oura-ring-gen3',
    variantKey,
    delta: -3,
    reason: 'integration conteo final',
    actor: 'it-admin',
    idempotencyKey: `it-adjust-empty-${randomUUID()}`,
  });
  assert.equal(empty.item.quantityOnHand, 0);
  assert.equal(empty.item.status, 'out');

  const increase = await inventoryAdmin.executeAdjustment({
    productSlug: 'oura-ring-gen3',
    variantKey,
    delta: 8,
    reason: 'integration reposición',
    actor: 'it-admin',
    idempotencyKey: `it-adjust-up-${randomUUID()}`,
  });
  assert.equal(increase.before.onHand, 0);
  assert.equal(increase.item.quantityOnHand, 8);
  assert.equal(increase.item.status, 'available');
});

test('ajuste inválido: no puede dejar el físico por debajo de lo reservado', async () => {
  // Producto REAL del catálogo (el admin valida contra `baseProductsData`).
  const slug = 'dyson-v15-detect';
  await seedProduct(slug, 5);
  await createOrder(slug, 2);

  await assert.rejects(
    () =>
      inventoryAdmin.executeAdjustment({
        productSlug: slug,
        variantKey: '',
        delta: -4,
        reason: 'integration invalid',
        actor: 'it-admin',
        idempotencyKey: `it-adjust-invalid-${randomUUID()}`,
      }),
    (error: unknown) =>
      error instanceof inventoryAdmin.InventoryAdminError && error.code === 'insufficient_stock',
  );

  const stock = await inventory(slug);
  assert.equal(stock.quantityOnHand, 5);
  assert.equal(stock.quantityReserved, 2);
});

test('doble clic concurrente: misma idempotencyKey crea UN pedido y reserva una vez', async () => {
  const slug = 'it-double-click';
  await seedProduct(slug, 10);
  const key = `it-double-${randomUUID()}`;

  const [first, second] = await Promise.all([
    createOrder(slug, 2, key),
    createOrder(slug, 2, key),
  ]);

  assert.equal(first.id, second.id);
  const stock = await inventory(slug);
  assert.equal(stock.quantityReserved, 2);
});

test('stock insuficiente: identifica el SKU y cuánto falta', async () => {
  const slug = 'it-shortage';
  await seedProduct(slug, 5);
  await createOrder(slug, 4);

  const availability = await commerce.getVariantAvailability([slug]);
  const shortages = findStockShortages(
    [{ productSlug: slug, productName: 'Shortage SKU', variantKey: '', quantity: 6 }],
    availability,
  );

  assert.equal(shortages.length, 1);
  assert.equal(shortages[0].productSlug, slug);
  assert.equal(shortages[0].requested, 6);
  assert.equal(shortages[0].available, 1);
});

test('ledger global filtra por pedido y tipo de movimiento', async () => {
  const slug = 'it-ledger';
  await seedProduct(slug, 4);
  const order = await createOrder(slug, 1);

  const byOrder = await commerce.listInventoryLedger({ order: order.orderNumber, limit: 20 });
  assert.equal(byOrder.entries.length >= 1, true);
  assert.equal(byOrder.entries.every((entry) => entry.orderNumber === order.orderNumber), true);
  assert.ok(byOrder.entries.some((entry) => entry.movementType === 'reservation'));

  const wrongType = await commerce.listInventoryLedger({
    order: order.orderNumber,
    movementType: 'receipt',
    limit: 20,
  });
  assert.equal(wrongType.entries.length, 0);
});
