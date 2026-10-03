/**
 * tests/helpers/confirm-payment-model.ts — MODELO DE REFERENCIA (solo para tests).
 *
 * ⚠️ LIMITACIÓN IMPORTANTE
 * La lógica REAL de la confirmación vive en PL/pgSQL: `confirm_order_payment`
 * (migración 002, reemplazada por la 005). Este archivo es una REIMPLEMENTACIÓN en
 * TypeScript que espeja, rama por rama, lo que hace esa función. Existe porque el
 * proyecto NO tiene Postgres en los tests (`node --test` no levanta una base), así
 * que no se puede invocar la función SQL directamente.
 *
 * Consecuencia: estos tests fijan la SEMÁNTICA esperada y protegen contra cambios
 * accidentales del modelo, pero NO ejecutan el SQL. Para verificar el SQL real hace
 * falta Postgres (ver la sección de verificación de la migración 005). La autoridad
 * es SIEMPRE el SQL; si ambos divergen, hay que corregir el SQL y este modelo.
 *
 * Reglas que se espejan (migración 005):
 *   CASO A  primer pago → confirma (con re-reserva si la reserva se liberó).
 *   CASO B  reintento del MISMO pago primario → NO-OP total (sin UPDATE).
 *   CASO C  segundo pago distinto → NO confirma/NO toca stock; preserva ambos pagos
 *           en receivedPayments (dedup por id) y marca duplicatePayment/needsReview
 *           (y amountMismatch si monto/moneda no cuadran).
 */

export interface ConfirmIncomingPayment {
  /** Id del pago en Mercado Pago (`p_payment_id`). */
  id: string;
  amount?: number | null;
  currency?: string | null;
  paymentMethodId?: string | null;
  status?: string | null;
  statusDetail?: string | null;
  dateApproved?: string | null;
  /** Snapshot crudo que la app manda como `p_payment_metadata`. */
  rawSnapshot?: Record<string, unknown>;
}

export interface ConfirmOrderState {
  total: number;
  currency: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  paymentReference: string | null;
  reservationReleased: boolean;
  version: number;
  confirmedAt: string | null;
  metadata: Record<string, unknown>;
}

export type ConfirmAction = 'confirmed' | 'needs_review' | 'duplicate' | 'noop';

export interface ConfirmEffects {
  action: ConfirmAction;
  confirmed: boolean;
  noop: boolean;
  duplicatePayment: boolean;
  amountMismatch: boolean;
  needsReview: boolean;
  metadataUpdated: boolean;
  rereservedLines: number;
  stockConflict: boolean;
  inventoryTouched: boolean;
}

export interface ConfirmOptions {
  now?: string;
  /** Simula `inventory_rereserve_order`: devuelve líneas o lanza si no hay stock. */
  rereserve?: (order: ConfirmOrderState) => number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Espeja `jsonb_strip_nulls(jsonb_build_object(...))`. */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function confirmOrderPaymentModel(
  order: ConfirmOrderState,
  payment: ConfirmIncomingPayment,
  options: ConfirmOptions = {},
): { order: ConfirmOrderState; effects: ConfirmEffects } {
  const now = options.now ?? '2026-10-03T12:00:00.000Z';

  const amountsMatch =
    (payment.amount == null || payment.amount === order.total) &&
    (payment.currency == null || payment.currency.toUpperCase() === order.currency.toUpperCase());

  const alreadyPaid = order.paymentStatus === 'paid';
  const confirmable =
    !alreadyPaid &&
    (order.status === 'pending_payment' || order.status === 'expired') &&
    amountsMatch;

  const existingPayment = asRecord(order.metadata.payment);
  const receivedExisting = asArray(existingPayment.receivedPayments);

  const primaryId =
    (order.paymentReference && order.paymentReference.length > 0
      ? order.paymentReference
      : null) ??
    (typeof receivedExisting[0]?.id === 'string' ? (receivedExisting[0].id as string) : null);

  const incoming = stripNulls({
    id: payment.id,
    amount: payment.amount ?? null,
    currency: payment.currency ?? null,
    paymentMethodId: payment.paymentMethodId ?? null,
    paymentTypeId: (payment.rawSnapshot?.paymentTypeId as string) ?? null,
    status: payment.status ?? null,
    statusDetail: payment.statusDetail ?? null,
    dateApproved: payment.dateApproved ?? null,
    receivedAt: now,
  });

  // ── CASO B — reintento del MISMO pago primario → NO-OP total ────────────────
  if (alreadyPaid && primaryId !== null && payment.id === primaryId) {
    return {
      order: clone(order),
      effects: {
        action: 'noop',
        confirmed: false,
        noop: true,
        duplicatePayment: false,
        amountMismatch: false,
        needsReview: false,
        metadataUpdated: false,
        rereservedLines: 0,
        stockConflict: false,
        inventoryTouched: false,
      },
    };
  }

  // ── CASO A — primer pago que confirma el pedido ────────────────────────────
  if (confirmable) {
    const received = [{ ...incoming, primary: true }];

    let rereservedLines = 0;
    let stockConflict = false;
    let stockConflictReason: string | null = null;
    if (order.reservationReleased && options.rereserve) {
      try {
        rereservedLines = options.rereserve(order);
      } catch (error) {
        stockConflict = true;
        stockConflictReason = error instanceof Error ? error.message : String(error);
      }
    }

    const updated = clone(order);
    updated.paymentReference = payment.id;
    updated.paymentMethod = payment.paymentMethodId ?? order.paymentMethod;
    updated.paymentStatus = 'paid';
    updated.status = 'confirmed';
    updated.version += 1;
    updated.confirmedAt = order.confirmedAt ?? now;
    updated.reservationReleased = stockConflict;
    updated.metadata = {
      ...order.metadata,
      payment: {
        ...existingPayment,
        ...(payment.rawSnapshot ?? {}),
        receivedPayments: received,
        lastPaymentId: payment.id,
        lastPaymentAmount: payment.amount ?? null,
        lastPaymentCurrency: payment.currency ?? null,
        lastPaymentAt: now,
        amountMismatch: false,
        duplicatePayment: false,
        needsReview: false,
        stockConflict,
        stockConflictReason,
        rereservedLines,
      },
    };

    return {
      order: updated,
      effects: {
        action: 'confirmed',
        confirmed: true,
        noop: false,
        duplicatePayment: false,
        amountMismatch: false,
        needsReview: false,
        metadataUpdated: true,
        rereservedLines,
        stockConflict,
        inventoryTouched: order.reservationReleased,
      },
    };
  }

  // ── Pedido NO pagado pero NO confirmable (monto/moneda no cuadran) ─────────
  if (!alreadyPaid) {
    const updated = clone(order);
    updated.metadata = {
      ...order.metadata,
      payment: {
        ...existingPayment,
        ...(payment.rawSnapshot ?? {}),
        lastPaymentId: payment.id,
        lastPaymentAmount: payment.amount ?? null,
        lastPaymentCurrency: payment.currency ?? null,
        lastPaymentAt: now,
        amountMismatch: !amountsMatch,
        needsReview: true,
      },
    };

    return {
      order: updated,
      effects: {
        action: 'needs_review',
        confirmed: false,
        noop: false,
        duplicatePayment: false,
        amountMismatch: !amountsMatch,
        needsReview: true,
        metadataUpdated: true,
        rereservedLines: 0,
        stockConflict: false,
        inventoryTouched: false,
      },
    };
  }

  // ── CASO C — segundo pago distinto sobre un pedido YA pagado ───────────────
  const received = [...receivedExisting];

  // Sembrar el pago primario si el historial aún no existe (pedidos pagados antes
  // de 005). Solo con datos que YA conocemos: nunca se inventan.
  if (primaryId !== null && !received.some((entry) => entry.id === primaryId)) {
    received.push(
      stripNulls({
        id: primaryId,
        amount: existingPayment.lastPaymentAmount ?? null,
        currency: existingPayment.lastPaymentCurrency ?? null,
        paymentMethodId: (existingPayment.paymentMethodId as string) ?? order.paymentMethod,
        paymentTypeId: (existingPayment.paymentTypeId as string) ?? null,
        status: (existingPayment.status as string) ?? null,
        statusDetail: (existingPayment.statusDetail as string) ?? null,
        dateApproved: (existingPayment.dateApproved as string) ?? null,
        receivedAt: (existingPayment.lastPaymentAt as string) ?? null,
        primary: true,
      }),
    );
  }

  // Dedup por Payment ID.
  if (!received.some((entry) => entry.id === payment.id)) {
    received.push(incoming);
  }

  const updated = clone(order);
  updated.metadata = {
    ...order.metadata,
    payment: {
      ...existingPayment,
      ...(payment.rawSnapshot ?? {}),
      receivedPayments: received,
      lastPaymentId: payment.id,
      lastPaymentAmount: payment.amount ?? null,
      lastPaymentCurrency: payment.currency ?? null,
      lastPaymentAt: now,
      amountMismatch: !amountsMatch,
      duplicatePayment: amountsMatch,
      needsReview: true,
    },
  };

  return {
    order: updated,
    effects: {
      action: 'duplicate',
      confirmed: false,
      noop: false,
      // El flag PERSISTIDO es `duplicatePayment = v_amounts_match`: solo un segundo
      // pago con monto/moneda correctos cuenta como duplicado válido.
      duplicatePayment: amountsMatch,
      amountMismatch: !amountsMatch,
      needsReview: true,
      metadataUpdated: true,
      rereservedLines: 0,
      stockConflict: false,
      inventoryTouched: false,
    },
  };
}
