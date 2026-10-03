import assert from 'node:assert/strict';
import test from 'node:test';
import { readOrderPaymentAudit } from '../lib/commerce';
import {
  confirmOrderPaymentModel,
  type ConfirmIncomingPayment,
  type ConfirmOrderState,
} from './helpers/confirm-payment-model';

/**
 * Guarda contra el SEGUNDO pago aprobado (migración 005).
 *
 * ⚠️ LIMITACIÓN (ver `tests/helpers/confirm-payment-model.ts`): la lógica real vive
 * en PL/pgSQL (`confirm_order_payment`). Estos tests ejercitan un MODELO en
 * TypeScript que la espeja, porque el proyecto no levanta Postgres en `node --test`.
 * El SQL real se valida con la sección de verificación de la migración 005 en un
 * entorno con base de datos.
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
    dateApproved: '2026-10-03T10:58:00.000Z',
    rawSnapshot: {
      status: 'approved',
      statusDetail: 'accredited',
      paymentMethodId: 'account_money',
      paymentTypeId: 'account_money',
      dateApproved: '2026-10-03T10:58:00.000Z',
      liveMode: true,
    },
    ...overrides,
  };
}

/** Pedido ya pagado, como queda tras un CASO A. */
function paidFromFirstPayment(): ConfirmOrderState {
  return confirmOrderPaymentModel(pendingOrder(), payment({ id: 'p1' }), { now: NOW }).order;
}

function paymentMeta(order: ConfirmOrderState): Record<string, unknown> {
  return (order.metadata.payment ?? {}) as Record<string, unknown>;
}

function auditOf(order: ConfirmOrderState) {
  return readOrderPaymentAudit({ metadata: order.metadata });
}

// =============================================================================
//  A — primer pago aprobado
// =============================================================================

test('A. primer pago aprobado: confirma y guarda el pago como primario', () => {
  const result = confirmOrderPaymentModel(pendingOrder(), payment({ id: 'p1' }), { now: NOW });

  assert.equal(result.effects.confirmed, true);
  assert.equal(result.order.status, 'confirmed');
  assert.equal(result.order.paymentStatus, 'paid');
  assert.equal(result.order.paymentReference, 'p1');
  assert.equal(result.order.paymentMethod, 'account_money');
  assert.equal(result.order.version, 1);
  assert.equal(result.order.confirmedAt, NOW);

  const audit = auditOf(result.order);
  assert.equal(audit?.needsReview, false);
  assert.equal(audit?.duplicatePayment, false);
  assert.equal(audit?.amountMismatch, false);
  assert.deepEqual(audit?.receivedPaymentIds, ['p1']);

  const received = paymentMeta(result.order).receivedPayments as Array<Record<string, unknown>>;
  assert.equal(received.length, 1);
  assert.equal(received[0].primary, true);
  assert.equal(received[0].amount, 749);
  assert.equal(received[0].status, 'approved');
});

// =============================================================================
//  B — retry del MISMO Payment ID
// =============================================================================

test('B. retry del mismo Payment ID: no-op idempotente, sin tocar nada', () => {
  const paid = paidFromFirstPayment();
  let rereserveCalls = 0;

  const result = confirmOrderPaymentModel(paid, payment({ id: 'p1' }), {
    now: LATER,
    rereserve: () => {
      rereserveCalls += 1;
      return 1;
    },
  });

  assert.equal(result.effects.noop, true);
  assert.equal(result.effects.confirmed, false);
  assert.equal(result.effects.metadataUpdated, false, 'no se reescribe metadata');
  assert.equal(result.effects.duplicatePayment, false);
  assert.equal(result.effects.needsReview, false);
  assert.equal(rereserveCalls, 0, 'no hay segunda reserva');
  assert.deepEqual(result.order, paid, 'pedido intacto (status, version, metadata)');
  assert.equal(result.order.version, 1);

  const audit = auditOf(result.order);
  assert.equal(audit?.needsReview, false);
  assert.equal(audit?.duplicatePayment, false);
  assert.deepEqual(audit?.receivedPaymentIds, ['p1']);
});

// =============================================================================
//  C — segundo Payment ID distinto, mismo monto/moneda
// =============================================================================

test('C. segundo Payment ID distinto: preserva referencia primaria y marca revisión', () => {
  const paid = paidFromFirstPayment();
  const versionBefore = paid.version;

  const result = confirmOrderPaymentModel(paid, payment({ id: 'p2' }), { now: LATER });

  assert.equal(result.effects.duplicatePayment, true);
  assert.equal(result.effects.needsReview, true);
  assert.equal(result.effects.amountMismatch, false);
  assert.equal(result.effects.inventoryTouched, false);
  assert.equal(result.effects.confirmed, false);

  assert.equal(result.order.status, 'confirmed', 'sigue confirmado');
  assert.equal(result.order.paymentStatus, 'paid');
  assert.equal(result.order.paymentReference, 'p1', 'la referencia primaria NO se sobrescribe');
  assert.equal(result.order.version, versionBefore, 'version sin cambios');
  assert.equal(result.order.confirmedAt, NOW, 'confirmed_at intacto');

  const audit = auditOf(result.order);
  assert.deepEqual(audit?.receivedPaymentIds, ['p1', 'p2'], 'ambos pagos preservados');
  assert.equal(audit?.duplicatePayment, true);
  assert.equal(audit?.needsReview, true);
});

// =============================================================================
//  D — repetición del segundo Payment ID
// =============================================================================

test('D. repetir el segundo Payment ID: no duplica receivedPayments', () => {
  const once = confirmOrderPaymentModel(paidFromFirstPayment(), payment({ id: 'p2' }), { now: LATER }).order;
  const twice = confirmOrderPaymentModel(once, payment({ id: 'p2' }), { now: LATER2 }).order;

  const audit = auditOf(twice);
  assert.deepEqual(audit?.receivedPaymentIds, ['p1', 'p2']);
  assert.equal(twice.paymentReference, 'p1');
});

// =============================================================================
//  E — tercer Payment ID distinto
// =============================================================================

test('E. tercer Payment ID distinto: se agrega una sola vez y la referencia sigue intacta', () => {
  const afterSecond = confirmOrderPaymentModel(paidFromFirstPayment(), payment({ id: 'p2' }), { now: LATER }).order;
  const afterThird = confirmOrderPaymentModel(afterSecond, payment({ id: 'p3' }), { now: LATER2 }).order;
  const repeated = confirmOrderPaymentModel(afterThird, payment({ id: 'p3' }), { now: LATER2 }).order;

  assert.deepEqual(auditOf(afterThird)?.receivedPaymentIds, ['p1', 'p2', 'p3']);
  assert.deepEqual(auditOf(repeated)?.receivedPaymentIds, ['p1', 'p2', 'p3'], 'sin duplicados');
  assert.equal(repeated.paymentReference, 'p1', 'referencia primaria intacta');
});

// =============================================================================
//  F — segundo pago con monto incorrecto
// =============================================================================

test('F. segundo pago con monto incorrecto: amountMismatch + needsReview, sin tocar stock/status', () => {
  const paid = paidFromFirstPayment();

  const result = confirmOrderPaymentModel(paid, payment({ id: 'p2', amount: 1 }), { now: LATER });

  assert.equal(result.effects.amountMismatch, true);
  assert.equal(result.effects.needsReview, true);
  assert.equal(result.effects.duplicatePayment, false, 'un pago problemático no es un duplicado válido');
  assert.equal(result.order.paymentReference, 'p1', 'primaria intacta');
  assert.equal(result.order.status, 'confirmed');
  assert.equal(result.order.paymentStatus, 'paid');
  assert.equal(result.order.version, paid.version);
  assert.deepEqual(auditOf(result.order)?.receivedPaymentIds, ['p1', 'p2'], 'evidencia preservada');
});

// =============================================================================
//  G — segundo pago con moneda incorrecta
// =============================================================================

test('G. segundo pago con moneda incorrecta: equivalente a F', () => {
  const paid = paidFromFirstPayment();

  const result = confirmOrderPaymentModel(paid, payment({ id: 'p2', currency: 'USD' }), { now: LATER });

  assert.equal(result.effects.amountMismatch, true);
  assert.equal(result.effects.needsReview, true);
  assert.equal(result.effects.duplicatePayment, false);
  assert.equal(result.order.paymentReference, 'p1');
  assert.equal(result.order.status, 'confirmed');
  assert.deepEqual(auditOf(result.order)?.receivedPaymentIds, ['p1', 'p2']);
});

// =============================================================================
//  H — re-reserva / conflicto de stock (sin regresiones)
// =============================================================================

test('H. pago tardío con re-reserva exitosa: confirma y vuelve a retener stock', () => {
  const expired = pendingOrder({ status: 'expired', reservationReleased: true });

  const result = confirmOrderPaymentModel(expired, payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => 2,
  });

  assert.equal(result.effects.confirmed, true);
  assert.equal(result.effects.stockConflict, false);
  assert.equal(result.effects.rereservedLines, 2);
  assert.equal(result.order.reservationReleased, false);
  assert.equal(result.order.status, 'confirmed');
  assert.equal(paymentMeta(result.order).stockConflict, false);
});

test('H. conflicto de stock: el dinero entró y se confirma igual, marcando stockConflict', () => {
  const expired = pendingOrder({ status: 'expired', reservationReleased: true });

  const result = confirmOrderPaymentModel(expired, payment({ id: 'p-late' }), {
    now: LATER,
    rereserve: () => {
      throw new Error('insufficient_stock');
    },
  });

  assert.equal(result.effects.confirmed, true, 'no se oculta el cobro');
  assert.equal(result.effects.stockConflict, true);
  assert.equal(result.order.status, 'confirmed');
  assert.equal(result.order.reservationReleased, true);
  assert.equal(paymentMeta(result.order).stockConflict, true);
  assert.match(String(paymentMeta(result.order).stockConflictReason), /insufficient_stock/);
});

// =============================================================================
//  Compatibilidad con pedidos pagados ANTES de 005 (sin receivedPayments)
// =============================================================================

test('C-legacy. pedido pagado sin receivedPayments: siembra el primario y no lo pierde', () => {
  const legacy: ConfirmOrderState = {
    total: 749,
    currency: 'PEN',
    status: 'confirmed',
    paymentStatus: 'paid',
    paymentMethod: 'account_money',
    paymentReference: 'p1',
    reservationReleased: false,
    version: 3,
    confirmedAt: NOW,
    metadata: {
      payment: {
        lastPaymentId: 'p1',
        lastPaymentAmount: 749,
        lastPaymentCurrency: 'PEN',
        lastPaymentAt: NOW,
        status: 'approved',
        statusDetail: 'accredited',
        amountMismatch: false,
        needsReview: false,
      },
    },
  };

  const result = confirmOrderPaymentModel(legacy, payment({ id: 'p2' }), { now: LATER });

  assert.equal(result.order.paymentReference, 'p1', 'la referencia primaria se conserva');
  assert.equal(result.order.version, legacy.version, 'version sin cambios');

  const received = paymentMeta(result.order).receivedPayments as Array<Record<string, unknown>>;
  assert.equal(received[0].id, 'p1');
  assert.equal(received[0].primary, true);
  assert.equal(received[0].amount, 749);
  assert.equal(received[0].currency, 'PEN');
  assert.deepEqual(auditOf(result.order)?.receivedPaymentIds, ['p1', 'p2']);
});

// =============================================================================
//  Lector de auditoría (lib/commerce.ts)
// =============================================================================

test('readOrderPaymentAudit refleja los flags nuevos y tolera metadata sin receivedPayments', () => {
  const withoutHistory = readOrderPaymentAudit({
    metadata: { payment: { lastPaymentId: 'x', needsReview: true } },
  });
  assert.equal(withoutHistory?.needsReview, true);
  assert.equal(withoutHistory?.duplicatePayment, false);
  assert.deepEqual(withoutHistory?.receivedPaymentIds, []);

  assert.equal(readOrderPaymentAudit({ metadata: {} }), null);
});
