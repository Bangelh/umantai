import assert from 'node:assert/strict';
import test from 'node:test';
import { isOrderFulfillmentBlocked, readOrderPaymentAudit } from '../lib/commerce';
import {
  confirmOrderPaymentModel,
  type ConfirmIncomingPayment,
  type ConfirmOrderState,
} from './helpers/confirm-payment-model';
import {
  applyStockConflictBackfill,
  evaluatePickupGuard,
  evaluateReadyGuard,
} from './helpers/fulfillment-guard-model';

/**
 * Guada de fulfillment ante PAGO APROBADO SIN STOCK (migración 006).
 *
 * ⚠️ LIMITACIÓN (ver `tests/helpers/*-model.ts`): la lógica real vive en PL/pgSQL
 * (`confirm_order_payment`, `mark_order_ready_for_pickup`, `inventory_commit_order`).
 * Estos tests ejercitan MODELOS en TypeScript que las espejan, porque el proyecto no
 * levanta Postgres en `node --test`. Fijan la SEMÁNTICA; el SQL real se valida con la
 * sección de verificación de la migración 006 en un entorno con base de datos.
 */

const NOW = '2026-10-03T10:58:00.000Z';
const LATER = '2026-10-03T11:00:00.000Z';
const LATER2 = '2026-10-03T11:05:00.000Z';

function pendingOrder(overrides: Partial<ConfirmOrderState> = {}): ConfirmOrderState {
  return {
    total: 749,
    currency: 'PEN',
    status: 'pending_payment',
    paymentStatus: 'pending',
    paymentMethod: null,
    paymentReference: null,
    reservationReleased: false,
    version: 0,
    confirmedAt: null,
    metadata: {},
    ...overrides,
  };
}

function payment(overrides: Partial<ConfirmIncomingPayment> & { id: string }): ConfirmIncomingPayment {
  return {
    amount: 749,
    currency: 'PEN',
    paymentMethodId: 'account_money',
    status: 'approved',
    statusDetail: 'accredited',
    dateApproved: NOW,
    rawSnapshot: {
      status: 'approved',
      statusDetail: 'accredited',
      paymentMethodId: 'account_money',
      paymentTypeId: 'account_money',
      dateApproved: NOW,
    },
    ...overrides,
  };
}

function guardOrder(order: ConfirmOrderState) {
  return { status: order.status, paymentStatus: order.paymentStatus, metadata: order.metadata };
}

function paymentMeta(order: ConfirmOrderState): Record<string, unknown> {
  return (order.metadata.payment ?? {}) as Record<string, unknown>;
}

function auditOf(order: ConfirmOrderState) {
  return readOrderPaymentAudit({ metadata: order.metadata });
}

/** Pedido tardío: nació pending_payment, el reaper liberó su reserva y quedó expired. */
function expiredWithReleasedReservation(): ConfirmOrderState {
  return pendingOrder({ status: 'expired', reservationReleased: true });
}

// =============================================================================
//  A — pago normal con reserva válida → fulfillment permitido
// =============================================================================

test('A. pago normal con reserva válida: paid/confirmed, sin review, fulfillment permitido', () => {
  const result = confirmOrderPaymentModel(pendingOrder(), payment({ id: 'p1' }), { now: NOW });

  assert.equal(result.order.status, 'confirmed');
  assert.equal(result.order.paymentStatus, 'paid');
  assert.equal(result.effects.needsReview, false);
  assert.equal(result.effects.stockConflict, false);

  const audit = auditOf(result.order);
  assert.equal(audit?.needsReview, false);
  assert.equal(audit?.stockConflict, false);
  assert.equal(isOrderFulfillmentBlocked(result.order), false);
  assert.deepEqual(evaluateReadyGuard(guardOrder(result.order)), { ok: true });
  assert.deepEqual(evaluatePickupGuard(guardOrder(result.order)), { ok: true });
});

// =============================================================================
//  B — pago tardío + reserva liberada + stock disponible → rereserva exitosa
// =============================================================================

test('B. pago tardío con rereserva exitosa: rereservedLines=1, sin conflicto, fulfillment permitido', () => {
  const result = confirmOrderPaymentModel(expiredWithReleasedReservation(), payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => 1,
  });

  assert.equal(result.effects.confirmed, true);
  assert.equal(result.effects.rereservedLines, 1);
  assert.equal(result.effects.stockConflict, false);
  assert.equal(result.effects.needsReview, false);
  assert.equal(result.order.reservationReleased, false, 'vuelve a tener reserva viva');

  const audit = auditOf(result.order);
  assert.equal(audit?.stockConflict, false);
  assert.equal(audit?.needsReview, false);
  assert.equal(isOrderFulfillmentBlocked(result.order), false);
  assert.deepEqual(evaluateReadyGuard(guardOrder(result.order)), { ok: true });
});

// =============================================================================
//  C — pago tardío + reserva liberada + SIN stock → conflicto + revisión
// =============================================================================

test('C. pago tardío sin stock: paid/confirmed, stockConflict + needsReview, fulfillment BLOQUEADO', () => {
  const result = confirmOrderPaymentModel(expiredWithReleasedReservation(), payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => {
      throw new Error('insufficient_stock');
    },
  });

  // El hecho económico se preserva.
  assert.equal(result.order.status, 'confirmed');
  assert.equal(result.order.paymentStatus, 'paid');
  assert.equal(result.order.paymentReference, 'p-late');
  assert.equal(result.order.reservationReleased, true);
  assert.equal(result.effects.rereservedLines, 0, 'no se creó una reserva inexistente');
  assert.equal(result.effects.stockConflict, true);
  assert.equal(result.effects.needsReview, true, '006: conflicto de stock ⇒ needsReview=true');

  const meta = paymentMeta(result.order);
  assert.equal(meta.stockConflict, true);
  assert.equal(meta.needsReview, true);
  assert.match(String(meta.stockConflictReason), /insufficient_stock/);

  const audit = auditOf(result.order);
  assert.equal(audit?.stockConflict, true);
  assert.equal(audit?.needsReview, true);
  assert.deepEqual(audit?.receivedPaymentIds, ['p-late'], 'el pago queda en receivedPayments');

  // Fulfillment bloqueado.
  assert.equal(isOrderFulfillmentBlocked(result.order), true);
  assert.deepEqual(evaluateReadyGuard(guardOrder(result.order)), { ok: false, code: 'order_requires_review' });
  assert.deepEqual(evaluatePickupGuard(guardOrder(result.order)), { ok: false, code: 'order_requires_review' });
});

// =============================================================================
//  D — retry del MISMO Payment ID del caso C → no-op de negocio
// =============================================================================

test('D. retry del mismo Payment ID tras conflicto: no-op, sin re-reservar, flags intactos', () => {
  const conflicted = confirmOrderPaymentModel(expiredWithReleasedReservation(), payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => {
      throw new Error('insufficient_stock');
    },
  }).order;

  let rereserveCalls = 0;
  const retry = confirmOrderPaymentModel(conflicted, payment({ id: 'p-late' }), {
    now: LATER2,
    rereserve: () => {
      rereserveCalls += 1;
      return 0;
    },
  });

  assert.equal(retry.effects.noop, true, 'es un no-op de negocio');
  assert.equal(retry.effects.metadataUpdated, false);
  assert.equal(rereserveCalls, 0, 'no vuelve a intentar reservar');
  assert.deepEqual(retry.order, conflicted, 'status/version/confirmedAt/metadata intactos');

  const audit = auditOf(retry.order);
  assert.equal(audit?.stockConflict, true, 'flags siguen true');
  assert.equal(audit?.needsReview, true);
  assert.deepEqual(audit?.receivedPaymentIds, ['p-late'], 'receivedPayments sin duplicar');
});

// =============================================================================
//  E — /ready sobre pedido en conflicto → rechazo sin PIN ni cambio de estado
// =============================================================================

test('E. /ready sobre pedido con stockConflict: rechazo order_requires_review', () => {
  const conflicted = confirmOrderPaymentModel(expiredWithReleasedReservation(), payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => {
      throw new Error('insufficient_stock');
    },
  }).order;

  // La guarda es una decisión pura: el modelo no emite PIN ni cambia estado.
  const before = structuredClone(conflicted);
  assert.deepEqual(evaluateReadyGuard(guardOrder(conflicted)), { ok: false, code: 'order_requires_review' });
  assert.deepEqual(conflicted, before, 'sin efecto sobre el pedido (no status change, no PIN)');
});

// =============================================================================
//  F — pickup/commit sobre pedido conflictivo → rechazo antes de tocar stock
// =============================================================================

test('F. pickup/commit sobre pedido en conflicto: rechazo antes de consumir inventario', () => {
  const conflicted = confirmOrderPaymentModel(expiredWithReleasedReservation(), payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => {
      throw new Error('insufficient_stock');
    },
  }).order;

  assert.deepEqual(evaluatePickupGuard(guardOrder(conflicted)), { ok: false, code: 'order_requires_review' });

  // Un pedido sano sí pasa la guarda de pickup (no hay regresión).
  const healthy = confirmOrderPaymentModel(pendingOrder(), payment({ id: 'p1' }), { now: NOW }).order;
  assert.deepEqual(evaluatePickupGuard(guardOrder(healthy)), { ok: true });
});

// =============================================================================
//  G — segundo pago aprobado (005) sigue funcionando, y también bloquea
// =============================================================================

test('G. segundo Payment ID aprobado (005): sin regresión, preserva primario y bloquea fulfillment', () => {
  const paid = confirmOrderPaymentModel(pendingOrder(), payment({ id: 'p1' }), { now: NOW }).order;
  const second = confirmOrderPaymentModel(paid, payment({ id: 'p2' }), { now: LATER });

  assert.equal(second.effects.duplicatePayment, true);
  assert.equal(second.effects.needsReview, true);
  assert.equal(second.order.paymentReference, 'p1', 'referencia primaria intacta');
  assert.deepEqual(auditOf(second.order)?.receivedPaymentIds, ['p1', 'p2']);
  assert.equal(isOrderFulfillmentBlocked(second.order), true, 'duplicado también exige revisión');
});

// =============================================================================
//  H — backfill 006 (solo toca needsReview de pedidos con stockConflict)
// =============================================================================

test('H. backfill: stockConflict=true + needsReview=false ⇒ needsReview=true, sin tocar nada más', () => {
  const affected = {
    status: 'confirmed',
    paymentStatus: 'paid',
    metadata: {
      payment: { stockConflict: true, stockConflictReason: 'insufficient_stock', needsReview: false },
    },
  };
  const backfilled = applyStockConflictBackfill(affected);

  assert.equal((backfilled.metadata.payment as Record<string, unknown>).needsReview, true);
  assert.equal(backfilled.status, affected.status, 'status intacto');
  assert.equal(backfilled.paymentStatus, affected.paymentStatus, 'paymentStatus intacto');
  assert.equal(
    (backfilled.metadata.payment as Record<string, unknown>).stockConflictReason,
    'insufficient_stock',
    'la razón se conserva',
  );
});

test('H. backfill es idempotente y no toca pedidos sin conflicto de stock', () => {
  const already = {
    status: 'confirmed',
    paymentStatus: 'paid',
    metadata: { payment: { stockConflict: true, needsReview: true } },
  };
  assert.deepEqual(applyStockConflictBackfill(already), already, 'ya en true: sin cambios');

  const noConflict = {
    status: 'confirmed',
    paymentStatus: 'paid',
    metadata: { payment: { stockConflict: false, needsReview: false } },
  };
  assert.deepEqual(applyStockConflictBackfill(noConflict), noConflict, 'sin stockConflict: sin cambios');

  const duplicate = {
    status: 'confirmed',
    paymentStatus: 'paid',
    metadata: { payment: { duplicatePayment: true, needsReview: true } },
  };
  assert.deepEqual(applyStockConflictBackfill(duplicate), duplicate, 'duplicado sin stockConflict: sin cambios');
});
