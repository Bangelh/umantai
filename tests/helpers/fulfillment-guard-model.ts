/**
 * tests/helpers/fulfillment-guard-model.ts — MODELO DE REFERENCIA (solo para tests).
 *
 * ⚠️ LIMITACIÓN IMPORTANTE
 * La guarda REAL vive en PL/pgSQL (migración 006): `mark_order_ready_for_pickup` e
 * `inventory_commit_order` lanzan `order_requires_review` si
 * `metadata.payment.stockConflict` o `metadata.payment.needsReview` son TRUE. El
 * proyecto NO tiene Postgres en `node --test`, así que no se puede invocar la función
 * SQL. Este archivo fija la SEMÁNTICA esperada de la guarda y del backfill para
 * protegerla contra cambios accidentales. La autoridad es SIEMPRE el SQL.
 *
 * La decisión de "bloqueado" reutiliza `isOrderFulfillmentBlocked()` de `lib/commerce`
 * (mismo predicado que el UI), y acá se modela cómo la aplican cada camino.
 */

import { isOrderFulfillmentBlocked } from '../../lib/commerce';

export interface GuardOrderState {
  status: string;
  paymentStatus: string;
  metadata: Record<string, unknown>;
}

export type FulfillmentGuardResult =
  | { ok: true }
  | {
      ok: false;
      code: 'order_not_found' | 'order_requires_review' | 'order_not_paid' | 'invalid_order_transition';
    };

/**
 * Espeja `mark_order_ready_for_pickup` (006): primero la guarda de conflicto, luego
 * pago y estado. Nunca emite PIN ni cambia estado si devuelve `ok:false`.
 */
export function evaluateReadyGuard(order: GuardOrderState): FulfillmentGuardResult {
  if (isOrderFulfillmentBlocked(order)) return { ok: false, code: 'order_requires_review' };
  if (order.paymentStatus !== 'paid') return { ok: false, code: 'order_not_paid' };
  if (order.status !== 'confirmed' && order.status !== 'preparing') {
    return { ok: false, code: 'invalid_order_transition' };
  }
  return { ok: true };
}

/**
 * Espeja la guarda de `inventory_commit_order` (006): se evalúa ANTES de aplicar
 * cualquier movimiento de stock, así que un pedido en conflicto no consume inventario.
 */
export function evaluatePickupGuard(order: GuardOrderState): FulfillmentGuardResult {
  if (isOrderFulfillmentBlocked(order)) return { ok: false, code: 'order_requires_review' };
  return { ok: true };
}

/**
 * Espeja el BACKFILL de la migración 006: si `metadata.payment.stockConflict` es TRUE
 * y `needsReview` no lo es, lo vuelve TRUE. No toca ninguna otra clave ni campo.
 */
export function applyStockConflictBackfill(order: GuardOrderState): GuardOrderState {
  const payment = order.metadata.payment;
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return order;

  const record = payment as Record<string, unknown>;
  if (record.stockConflict !== true || record.needsReview === true) return order;

  return {
    ...order,
    metadata: {
      ...order.metadata,
      payment: { ...record, needsReview: true },
    },
  };
}
