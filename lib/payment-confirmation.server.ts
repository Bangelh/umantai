/**
 * lib/payment-confirmation.server.ts — la frontera entre "validación externa" y
 * "trabajo interno" de un pago aprobado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  `POST /api/payments/webhook` hace dos cosas muy distintas y conviene no
 *  confundirlas:
 *
 *    1. VALIDACIÓN EXTERNA — firma HMAC, tipo de notificación y releer el pago
 *       contra la API de Mercado Pago con nuestro access token. Es lo único que un
 *       atacante no puede fabricar.
 *    2. TRABAJO INTERNO — confirmar el pedido (atómico e idempotente), decidir si
 *       el fulfillment queda bloqueado y avisar a la TIENDA.
 *
 *  El paso 2 es EXACTAMENTE lo que también necesita el simulador QA: queremos un
 *  pago aprobado falso que entre por el MISMO camino, sin reimplementar ni una
 *  regla de negocio.
 *
 *  Este módulo expone esa frontera. Nada de acá valida firmas ni llama a Mercado
 *  Pago: recibe un pago ya considerado aprobado y aplica el flujo interno.
 *  Si cambia la semántica de "pago aplicado", cambia en un solo lugar.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readOrderPaymentAudit, type Order, type OrderPaymentAudit } from './commerce';
import { confirmOrderPayment } from './commerce.server';
import { notifyNewOrderSafely, type CustomerNotificationResult } from './notifications.server';

/** De dónde salió el pago aprobado. Queda en `orders.metadata.payment.source`. */
export type PaymentSource = 'mercadopago' | 'simulation';

export interface ApplyApprovedPaymentInput {
  /** Id del pago: real de Mercado Pago o `SIMULATED-MP-…` (nunca se confunden). */
  paymentId: string;
  /** `orders.order_number`, que viaja como `payment.external_reference`. */
  orderNumber: string;
  paymentMethod?: string | null;
  /** Monto que el pago dice haber cobrado. La base lo valida contra `orders.total`. */
  paidAmount?: number | null;
  currency?: string | null;
  /** `false` = sandbox. Distinguirlo evita dar por pagado un pedido real con un pago TEST. */
  liveMode?: boolean | null;
  source: PaymentSource;
  /** Snapshot adicional del pago (status_detail, método, fecha…). */
  paymentMetadata?: Record<string, unknown>;
  actor?: string;
}

export interface ApplyApprovedPaymentResult {
  order: Order;
  /** Qué quedó escrito en `orders.metadata.payment` (o `null` si no hay cobro). */
  audit: OrderPaymentAudit | null;
  /**
   * El fulfillment NO debe continuar sin intervención humana: conflicto de stock,
   * revisión pendiente o pago duplicado. Espeja la guarda de la migración 006.
   */
  fulfillmentBlocked: boolean;
  /** Aviso a la TIENDA. `null` cuando el pedido no debía avisarse (bloqueado). */
  storeNotification: CustomerNotificationResult | null;
}

/**
 * Aplica un pago aprobado al pedido. Devuelve `null` si el `order_number` no existe
 * en esta base (típicamente una credencial de prueba apuntando a otra base).
 *
 * La confirmación en sí vive en `confirm_order_payment()` (PL/pgSQL): es UNA unidad
 * atómica —bloquear el pedido, re-reservar el stock liberado por el reaper y confirmar—
 * e idempotente (reintento del mismo pago = no-op; un segundo pago distinto marca
 * `duplicatePayment`/`needsReview` sin confirmar dos veces).
 *
 * Después de confirmar, decide si corresponde avisar a la tienda. Un cobro que NO
 * pudo retener stock (o que quedó pendiente de revisión) NO debe presentarse como
 * "normal listo para preparar": en ese caso no se llama a `notifyNewOrderSafely`.
 */
export async function applyApprovedPayment(
  input: ApplyApprovedPaymentInput,
): Promise<ApplyApprovedPaymentResult | null> {
  const order = await confirmOrderPayment({
    orderNumber: input.orderNumber,
    paymentId: input.paymentId,
    paymentMethod: input.paymentMethod ?? null,
    paidAmount: input.paidAmount ?? null,
    currency: input.currency ?? null,
    paymentMetadata: {
      status: 'approved',
      source: input.source,
      liveMode: input.liveMode ?? null,
      ...(input.paymentMetadata ?? {}),
    },
    actor:
      input.actor ?? (input.source === 'simulation' ? 'qa:simulate-payment' : 'mercadopago:webhook'),
  });

  if (!order) return null;

  const audit = readOrderPaymentAudit(order);

  // DECISIÓN (006): un cobro que no pudo retener stock, que quedó pendiente de
  // revisión o que es un segundo pago sobre un pedido ya pagado bloquea el
  // fulfillment (la base también lo impide con `order_requires_review`).
  const fulfillmentBlocked = Boolean(
    audit?.stockConflict || audit?.needsReview || audit?.duplicatePayment,
  );

  let storeNotification: CustomerNotificationResult | null = null;
  if (!fulfillmentBlocked && order.status === 'confirmed' && order.paymentStatus === 'paid') {
    // Best-effort: `notifyNewOrderSafely` nunca lanza y su clave de idempotencia
    // (`new-order-<id>`) evita duplicar el correo en reintentos.
    storeNotification = await notifyNewOrderSafely(order.id);
  }

  return { order, audit, fulfillmentBlocked, storeNotification };
}
