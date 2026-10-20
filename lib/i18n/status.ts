/**
 * lib/i18n/status.ts — estados de pedido traducidos.
 *
 * `ORDER_STATUS_LABELS` sigue existiendo para código de dominio y logs, pero la
 * UI usa este helper para no mostrar español cuando el locale es `en`.
 */

import type { MessageKey } from './dictionaries';
import type { Translator } from './index';

const KNOWN = new Set<MessageKey>([
  'status.pending_payment',
  'status.confirmed',
  'status.preparing',
  'status.ready_for_pickup',
  'status.picked_up',
  'status.out_for_delivery',
  'status.delivered',
  'status.completed',
  'status.cancelled',
  'status.expired',
  'status.refunded',
]);

/** Devuelve el estado traducido o el valor crudo si aparece uno nuevo. */
export function orderStatusLabel(t: Translator, status: string): string {
  const key = `status.${status}` as MessageKey;
  return KNOWN.has(key) ? t(key) : status;
}
