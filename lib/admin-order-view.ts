import {
  readOrderPaymentAudit,
  type FulfillmentType,
  type OrderChannel,
  type OrderItemRow,
  type OrderRow,
  type OrderStatus,
  type PaymentStatus,
  type PickupCodeRow,
  type PickupCodeStatus,
} from './commerce';

/**
 * lib/admin-order-view.ts — VISTA ADMINISTRATIVA de un pedido (solo lectura).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE (y por qué NO se reusa el tipo de dominio)
 *
 *  `toOrder()` devuelve el pedido COMPLETO, incluido `publicToken` (la llave con la
 *  que cualquiera abre `/pedido/<token>`) y `paymentReference`. `toPickupCode()`
 *  devuelve el PIN en claro. Nada de eso puede salir por un endpoint de diagnóstico.
 *
 *  Este módulo es una lista BLANCA explícita: se enumeran los campos que sí viajan.
 *  Todo lo demás (token público, PIN, referencia de pago, clave de idempotencia,
 *  metadata cruda con DNI) no existe en el DTO.
 *
 *  Es una función PURA (sin base ni red), así que la redacción se prueba en
 *  `tests/qa-order-cleanup.test.ts`: si mañana alguien agrega un campo, el test que
 *  serializa la vista y busca el token/PIN lo delata.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface AdminOrderItemView {
  productSlug: string;
  productName: string;
  variantKey: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/**
 * Estado del PIN de retiro. NUNCA incluye el código: el PIN es el control de que
 * quien retira es quien compró; un endpoint de diagnóstico no lo necesita.
 */
export interface AdminOrderPickupCodeView {
  status: PickupCodeStatus;
  /** Vigente: emitido y sin vencer. Es lo único que permite un retiro. */
  isActive: boolean;
  /** `issued` pero fuera de fecha (el vencimiento es perezoso: la BD lo marca al usarlo). */
  isExpired: boolean;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  lockerCode: string | null;
  lockerSlot: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  redeemedAt: string | null;
  createdAt: string;
}

export interface AdminOrderView {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentType: FulfillmentType;
  channel: OrderChannel;
  customerName: string | null;
  contactEmail: string;
  contactPhone: string | null;
  createdAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  total: number;
  currency: string;
  lockerCode: string | null;
  /** Ya se soltó el stock retenido (cancelación / expiración). */
  reservationReleased: boolean;
  reservationExpiresAt: string | null;
  /** Pago aprobado que quedó pendiente de revisión (conflicto de stock / duplicado). */
  needsReview: boolean;
  stockConflict: boolean;
  itemCount: number;
  items: AdminOrderItemView[];
  /** PIN más reciente del pedido (o `null` si nunca se emitió). Sin el código. */
  pickupCode: AdminOrderPickupCodeView | null;
  /** ¿Hay ALGÚN PIN vigente? Lo que decide si el pedido puede retirarse hoy. */
  hasActivePickupCode: boolean;
}

/** Nombre del comprador guardado por el checkout invitado (`metadata.buyer.fullName`). */
function readBuyerName(metadata: Record<string, unknown> | null | undefined): string | null {
  const buyer = metadata?.buyer;
  if (!buyer || typeof buyer !== 'object' || Array.isArray(buyer)) return null;
  const name = (buyer as Record<string, unknown>).fullName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Estado de un PIN para la vista. `now` se inyecta para poder probar el vencimiento
 * sin depender del reloj (y para que dos PINs del mismo pedido se evalúen igual).
 */
export function toAdminPickupCodeView(
  row: PickupCodeRow,
  now: Date = new Date(),
): AdminOrderPickupCodeView {
  const expiresAt = row.expires_at;
  const expiredByClock = new Date(expiresAt).getTime() <= now.getTime();

  return {
    status: row.status,
    isActive: row.status === 'issued' && !expiredByClock,
    isExpired: row.status === 'issued' && expiredByClock,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    expiresAt,
    lockerCode: row.locker_code,
    lockerSlot: row.locker_slot,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at,
  };
}

/**
 * Vista administrativa de un pedido: cabecera + líneas + PIN más reciente.
 *
 * `pickupCodes` puede venir en cualquier orden; el "más reciente" se resuelve acá por
 * `created_at` para que el listado no dependa de cómo lo ordenó la query.
 */
export function toAdminOrderView(
  order: OrderRow,
  items: OrderItemRow[],
  pickupCodes: PickupCodeRow[] = [],
  now: Date = new Date(),
): AdminOrderView {
  const audit = readOrderPaymentAudit({ metadata: order.metadata });

  const orderedCodes = [...pickupCodes].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const codeViews = orderedCodes.map((row) => toAdminPickupCodeView(row, now));

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    fulfillmentType: order.fulfillment_type,
    channel: order.channel,
    customerName: readBuyerName(order.metadata),
    contactEmail: order.contact_email,
    contactPhone: order.contact_phone,
    createdAt: order.created_at,
    confirmedAt: order.confirmed_at,
    readyAt: order.ready_at,
    total: num(order.total),
    currency: order.currency,
    lockerCode: order.locker_code,
    reservationReleased: order.reservation_released,
    reservationExpiresAt: order.reservation_expires_at,
    needsReview: Boolean(audit?.needsReview),
    stockConflict: Boolean(audit?.stockConflict),
    itemCount: order.item_count,
    items: items.map((item) => ({
      productSlug: item.product_slug,
      productName: item.product_name,
      variantKey: item.variant_key,
      quantity: item.quantity,
      unitPrice: num(item.unit_price),
      lineTotal: num(item.line_total),
    })),
    pickupCode: codeViews[0] ?? null,
    hasActivePickupCode: codeViews.some((code) => code.isActive),
  };
}

// =============================================================================
//  RESERVA VIVA (auditoría READ-ONLY del ledger)
//
//  La autoridad de "qué pedido retiene stock" NO es `orders.status`: es el LEDGER.
//  Una línea tiene reserva viva si existe un movimiento `reservation` para ella y
//  NINGÚN `reservation_release`/`sale`. Ese es el predicado exacto de
//  `inventory_release_order()` (001_commerce_core.sql), y por eso una reserva puede
//  sobrevivir en un pedido `cancelled`/`expired`/`pending_payment` invisible al kiosco.
//
//  Este módulo NO descubre nada nuevo: reutiliza la lista blanca de `AdminOrderView`
//  (sin token público, PIN, referencia de pago ni metadata) y le agrega las líneas
//  retenidas + los movimientos de inventario que las explican.
// =============================================================================

/** Un movimiento del ledger, tal como se muestra en la auditoría (sin `inventory_id`). */
export interface AdminInventoryMovementView {
  id: string;
  movementType: string;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  reason: string | null;
  performedBy: string | null;
  createdAt: string;
}

/** Los dos hechos del ledger que deciden si una línea está retenida hoy. */
export interface AdminReservationLineFacts {
  /** Existe un movimiento `reservation` para la línea. */
  hasReservation: boolean;
  /** Existe un `reservation_release` o un `sale`: la retención ya no está viva. */
  hasReleaseOrSale: boolean;
}

/** Entrada del mapper: la línea del pedido + lo que dice el ledger sobre ella. */
export interface AdminReservationLineInput extends AdminReservationLineFacts {
  item: OrderItemRow;
  movements: AdminInventoryMovementView[];
}

export interface AdminReservationLineView {
  orderItemId: string;
  productSlug: string;
  productName: string;
  variantKey: string;
  quantity: number;
  /** Movimientos del ledger de ESTA línea, más reciente primero. */
  movements: AdminInventoryMovementView[];
}

/**
 * Vista de un pedido que retiene stock AHORA. Extiende `AdminOrderView` (misma
 * redacción) y agrega solo lo que la auditoría necesita para explicar la retención.
 */
export interface AdminReservationHolderView extends AdminOrderView {
  /** Líneas con reserva viva (reserva sin liberar ni vender). */
  reservationLines: AdminReservationLineView[];
  /** Unidades retenidas ahora (suma de `quantity` de esas líneas). */
  reservedUnits: number;
}

/**
 * Predicado de "reserva viva": espejo EXACTO de la guarda de `inventory_release_order()`.
 * La query ya lo calcula en SQL; esta función pura fija la semántica y la cubre con tests.
 */
export function isActivelyReservedLine(facts: AdminReservationLineFacts): boolean {
  return facts.hasReservation && !facts.hasReleaseOrSale;
}

/**
 * Vista de un pedido que retiene stock. `lines` debe traer TODAS las líneas del pedido
 * (con sus hechos del ledger); las que no están vivas igual aparecen en `items`.
 */
export function toAdminReservationHolderView(
  order: OrderRow,
  lines: AdminReservationLineInput[],
  pickupCodes: PickupCodeRow[] = [],
  now: Date = new Date(),
): AdminReservationHolderView {
  const base = toAdminOrderView(
    order,
    lines.map((line) => line.item),
    pickupCodes,
    now,
  );

  const active = lines.filter(isActivelyReservedLine);

  return {
    ...base,
    reservationLines: active.map((line) => ({
      orderItemId: line.item.id,
      productSlug: line.item.product_slug,
      productName: line.item.product_name,
      variantKey: line.item.variant_key,
      quantity: line.item.quantity,
      movements: line.movements,
    })),
    reservedUnits: active.reduce((sum, line) => sum + line.item.quantity, 0),
  };
}
