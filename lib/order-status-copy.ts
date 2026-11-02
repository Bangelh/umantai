/**
 * lib/order-status-copy.ts — ÚNICA fuente de copy de estados de pedido.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  Cada pantalla escribía su propia versión del estado: el panel del merchant decía
 *  "Pendiente de pago", la página del comprador "Pendiente de pago" y el kiosco
 *  "Pagado". Además, un comerciante con poca experiencia en software se encontraba
 *  con `pending_payment` sin ninguna explicación de que NO debía preparar nada.
 *
 *  Acá se define, para cada estado del enum (`lib/commerce.ts` → `ORDER_STATUSES`):
 *    · la etiqueta visible,
 *    · la explicación en lenguaje humano,
 *    · la siguiente acción PERMITIDA (solo las que la máquina de estados ya permite),
 *    · el tono del badge y si el pedido va al grupo secundario.
 *
 *  NO define transiciones: la autoridad sigue siendo
 *  `order_status_transitions` en Postgres. Este módulo solo describe lo que ya
 *  existe, para que el UI no invente pasos.
 *
 *  Este archivo no importa React: lo consumen Server Components y los tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { OrderStatus, PaymentStatus } from './commerce';

export type OrderTone = 'attention' | 'progress' | 'success' | 'neutral' | 'danger';

export interface OrderStatusCopy {
  /** Etiqueta visible. `null` = usar el override del merchant (`merchantLabelKey`). */
  labelKey: `status.${OrderStatus}`;
  /** Override de etiqueta solo para el panel del merchant. */
  merchantLabelKey?: 'merchant.waitingPayment';
  /** Qué significa el estado, sin jerga. */
  explanationKey: string;
  /** Siguiente acción permitida. Nunca una transición que la base rechace. */
  actionKey: string;
  tone: OrderTone;
  /** ¿La tienda tiene que mirarlo? */
  needsAttention: boolean;
  /** Historial: se muestra atenuado y después de los pedidos vivos. */
  secondary: boolean;
  /** Estados en los que el personal SÍ puede preparar/entregar (ya existen en el kiosco). */
  actionable: boolean;
}

const COPY: Record<OrderStatus, OrderStatusCopy> = {
  pending_payment: {
    labelKey: 'status.pending_payment',
    merchantLabelKey: 'merchant.waitingPayment',
    explanationKey: 'orderStatus.pending_payment.explanation',
    actionKey: 'orderStatus.pending_payment.action',
    tone: 'attention',
    needsAttention: true,
    secondary: false,
    // El stock está retenido, pero preparar mercadería impaga rompe la invariante
    // pago → preparación. Por eso `actionable` es false aunque sea un pedido vivo.
    actionable: false,
  },
  confirmed: {
    labelKey: 'status.confirmed',
    explanationKey: 'orderStatus.confirmed.explanation',
    actionKey: 'orderStatus.confirmed.action',
    tone: 'progress',
    needsAttention: true,
    secondary: false,
    actionable: true,
  },
  preparing: {
    labelKey: 'status.preparing',
    explanationKey: 'orderStatus.preparing.explanation',
    actionKey: 'orderStatus.preparing.action',
    tone: 'progress',
    needsAttention: true,
    secondary: false,
    actionable: true,
  },
  ready_for_pickup: {
    labelKey: 'status.ready_for_pickup',
    explanationKey: 'orderStatus.ready_for_pickup.explanation',
    actionKey: 'orderStatus.ready_for_pickup.action',
    tone: 'success',
    needsAttention: true,
    secondary: false,
    actionable: true,
  },
  picked_up: {
    labelKey: 'status.picked_up',
    explanationKey: 'orderStatus.picked_up.explanation',
    actionKey: 'orderStatus.picked_up.action',
    tone: 'neutral',
    needsAttention: false,
    secondary: true,
    actionable: false,
  },
  out_for_delivery: {
    labelKey: 'status.out_for_delivery',
    explanationKey: 'orderStatus.out_for_delivery.explanation',
    actionKey: 'orderStatus.out_for_delivery.action',
    tone: 'progress',
    needsAttention: true,
    secondary: false,
    actionable: true,
  },
  delivered: {
    labelKey: 'status.delivered',
    explanationKey: 'orderStatus.delivered.explanation',
    actionKey: 'orderStatus.delivered.action',
    tone: 'neutral',
    needsAttention: false,
    secondary: true,
    actionable: false,
  },
  completed: {
    labelKey: 'status.completed',
    explanationKey: 'orderStatus.completed.explanation',
    actionKey: 'orderStatus.completed.action',
    tone: 'neutral',
    needsAttention: false,
    secondary: true,
    actionable: false,
  },
  cancelled: {
    labelKey: 'status.cancelled',
    explanationKey: 'orderStatus.cancelled.explanation',
    actionKey: 'orderStatus.cancelled.action',
    tone: 'danger',
    needsAttention: false,
    secondary: true,
    actionable: false,
  },
  expired: {
    labelKey: 'status.expired',
    explanationKey: 'orderStatus.expired.explanation',
    actionKey: 'orderStatus.expired.action',
    tone: 'danger',
    needsAttention: false,
    secondary: true,
    actionable: false,
  },
  refunded: {
    labelKey: 'status.refunded',
    explanationKey: 'orderStatus.refunded.explanation',
    actionKey: 'orderStatus.refunded.action',
    tone: 'danger',
    needsAttention: false,
    secondary: true,
    actionable: false,
  },
};

/** Orden estable para agrupar la lista del merchant (vivos primero). */
export const ORDER_STATUS_DISPLAY_ORDER: readonly OrderStatus[] = [
  'pending_payment',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'out_for_delivery',
  'picked_up',
  'delivered',
  'completed',
  'cancelled',
  'expired',
  'refunded',
];

/**
 * Copy del estado. Un valor desconocido (enum nuevo en la base) NO rompe la
 * pantalla: cae en neutro y sin acción, que es el lado seguro.
 */
export function orderStatusCopy(status: string): OrderStatusCopy {
  return COPY[status as OrderStatus] ?? COPY.completed;
}

/** ¿Se puede preparar/entregar este pedido con los flujos que YA existen? */
export function isOrderActionable(status: string): boolean {
  return orderStatusCopy(status).actionable;
}

/** Etiqueta del merchant (con override explícito para `pending_payment`). */
export function merchantOrderStatusKey(status: string): string {
  const copy = orderStatusCopy(status);
  return copy.merchantLabelKey ?? copy.labelKey;
}

/** Etiquetas de estado de pago. Centralizadas para no repetir textos por pantalla. */
export const PAYMENT_STATUS_KEYS: Record<PaymentStatus, string> = {
  pending: 'paymentStatus.pending',
  authorized: 'paymentStatus.authorized',
  paid: 'paymentStatus.paid',
  failed: 'paymentStatus.failed',
  partially_refunded: 'paymentStatus.partially_refunded',
  refunded: 'paymentStatus.refunded',
};

export function paymentStatusKey(status: string): string {
  return PAYMENT_STATUS_KEYS[status as PaymentStatus] ?? 'paymentStatus.pending';
}
