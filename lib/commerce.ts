/**
 * lib/commerce.ts — Motor transaccional (Fase 1): tipos del contrato.
 *
 * Espeja 1:1 lo que define `db/migrations/001_commerce_core.sql`. Este archivo
 * NO importa nada (ni React, ni zustand, ni el cliente de base de datos): se puede
 * usar tanto en Server Components / route handlers como en componentes cliente.
 *
 * Convención de capas (igual que el resto del repo, ver `lib/db.ts`):
 *   · `*Row`    → forma cruda de la fila en Postgres (snake_case).
 *   · dominio   → forma camelCase que consume el frontend, vía los mappers `to*()`.
 *
 * GOTCHA IMPORTANTE: Neon/pg devuelven las columnas NUMERIC como `string` para no
 * perder precisión. Por eso los `*Row` declaran dinero como `string` y los mappers
 * lo convierten a `number` (los montos del MVP son seguros en Number; si algún día
 * se manejan montos > 2^53, migrar a decimal.js).
 */

// =============================================================================
//  1. ENUMS (espejo de los tipos ENUM de Postgres)
//     Las tuplas `as const` sirven para recorrerlas en el UI (filtros, selects).
// =============================================================================

export const ORDER_STATUSES = [
  'pending_payment',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'completed',
  'cancelled',
  'expired',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_CHANNELS = ['web', 'kiosk', 'admin', 'whatsapp'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const FULFILLMENT_TYPES = ['pickup_locker', 'pickup_counter', 'delivery'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const INVENTORY_MOVEMENT_TYPES = [
  'receipt',
  'reservation',
  'reservation_release',
  'sale',
  'adjustment',
  'recount',
  'return',
  'shrinkage',
  'transfer_in',
  'transfer_out',
] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

export const PICKUP_CODE_STATUSES = ['issued', 'redeemed', 'expired', 'revoked'] as const;
export type PickupCodeStatus = (typeof PICKUP_CODE_STATUSES)[number];

// =============================================================================
//  2. MÁQUINA DE ESTADOS
//
//  La fuente de verdad es la tabla `order_status_transitions` (el trigger
//  `enforce_order_status_transition` rechaza cualquier transición que no esté ahí).
//  Esta copia existe solo para que el UI sepa qué botones mostrar SIN ir al
//  servidor en cada render. Si cambias la tabla, cambia esto también.
// =============================================================================

export const ORDER_STATUS_TRANSITIONS = {
  pending_payment: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['preparing', 'cancelled', 'refunded'],
  preparing: ['ready_for_pickup', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['picked_up', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  picked_up: ['completed', 'refunded'],
  delivered: ['completed', 'refunded'],
  completed: ['refunded'],
  cancelled: [],
  expired: [],
  refunded: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

/** Estados sin salida: un pedido aquí ya no se mueve. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['cancelled', 'expired', 'refunded'];

/** Estados en los que el stock está retenido por una reserva. */
export const STOCK_RESERVING_STATUSES: readonly OrderStatus[] = ['pending_payment', 'confirmed', 'preparing'];

/** Estados previos al retiro en los que el pedido sigue vivo para el cliente. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  'pending_payment',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'out_for_delivery',
];

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/** Estados alcanzables desde `from`. */
export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[from];
}

/** Misma validación que hace el trigger en Postgres. Úsala para deshabilitar acciones, no para autorizar. */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  const allowed: readonly OrderStatus[] = ORDER_STATUS_TRANSITIONS[from];
  return allowed.includes(to);
}

// =============================================================================
//  2.b ¿SE PUEDE COBRAR TODAVÍA?
// =============================================================================

/**
 * Motivos por los que un pedido no se puede pagar. `'payable'` = sí se puede.
 *
 * Se usan como código de error en la API (`POST /api/payments/preference`).
 */
export type OrderPayability = 'payable' | 'order_not_payable' | 'reservation_expired';

/**
 * ¿Este pedido todavía se puede cobrar?
 *
 * Dos razones para decir que no:
 *   · `order_not_payable`     — ya no está en `pending_payment` (pagado, cancelado,
 *                               vencido…). Cobrarlo generaría un pago huérfano.
 *   · `reservation_expired`   — la reserva de stock venció. El reaper puede tardar
 *                               hasta un minuto en marcarlo `expired`, así que el
 *                               estado todavía dice `pending_payment` aunque el stock
 *                               ya se pudo vender a otra persona.
 *
 * Vive acá (y no en la ruta) para que la página de estado y el endpoint coincidan: si
 * solo lo validara el endpoint, la UI mostraría un botón de pagar que siempre falla.
 *
 * @param nowMs Reloj inyectable — los tests no deberían depender de la hora real.
 */
export function evaluateOrderPayability(
  order: Pick<Order, 'status' | 'reservationExpiresAt'>,
  nowMs: number = Date.now(),
): OrderPayability {
  if (order.status !== 'pending_payment') return 'order_not_payable';

  if (order.reservationExpiresAt) {
    const expiresAt = Date.parse(order.reservationExpiresAt);
    // Fecha ilegible = no bloqueamos la venta por un dato raro.
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return 'reservation_expired';
  }

  return 'payable';
}

// =============================================================================
//  3. GUARDS DE RUNTIME
// =============================================================================

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isOrderStatus = (value: unknown): value is OrderStatus => isOneOf(ORDER_STATUSES, value);
export const isOrderChannel = (value: unknown): value is OrderChannel => isOneOf(ORDER_CHANNELS, value);
export const isFulfillmentType = (value: unknown): value is FulfillmentType => isOneOf(FULFILLMENT_TYPES, value);
export const isPaymentStatus = (value: unknown): value is PaymentStatus => isOneOf(PAYMENT_STATUSES, value);
export const isInventoryMovementType = (value: unknown): value is InventoryMovementType =>
  isOneOf(INVENTORY_MOVEMENT_TYPES, value);
export const isPickupCodeStatus = (value: unknown): value is PickupCodeStatus => isOneOf(PICKUP_CODE_STATUSES, value);

// =============================================================================
//  4. FILAS CRUDAS (snake_case, tal como las devuelve Postgres)
// =============================================================================

export interface CustomerRow {
  id: string;
  email: string;
  phone: string | null;
  full_name: string;
  doc_type: string | null;
  doc_number: string | null;
  auth_user_id: string | null;
  default_address: ShippingAddress | null;
  marketing_opt_in: boolean;
  total_orders: number;
  total_spent: string; // NUMERIC
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OrderRow {
  id: string;
  order_number: string;
  public_token: string;
  idempotency_key: string | null;
  customer_id: string | null;
  contact_email: string;
  contact_phone: string | null;
  channel: OrderChannel;
  fulfillment_type: FulfillmentType;
  locker_code: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: string | null;
  payment_reference: string | null;
  currency: string;
  subtotal: string; // NUMERIC
  discount_total: string;
  tax_total: string;
  shipping_total: string;
  total: string;
  item_count: number;
  shipping_address: ShippingAddress | null;
  pickup_instructions: string | null;
  customer_note: string | null;
  reservation_expires_at: string | null;
  reservation_released: boolean;
  confirmed_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  line_number: number;
  product_slug: string;
  product_name: string;
  product_brand: string | null;
  image_url: string | null;
  variant_key: string;
  variant: ProductVariant;
  quantity: number;
  unit_price: string; // NUMERIC
  discount_amount: string;
  tax_amount: string;
  line_total: string;
  created_at: string;
  updated_at: string;
}

export interface InventoryRow {
  id: string;
  location_code: string;
  product_slug: string;
  variant_key: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  /** Columna GENERADA en Postgres: siempre `on_hand - reserved`. Nunca se escribe. */
  quantity_available: number;
  reorder_point: number;
  restock_eta: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InventoryMovementRow {
  id: string; // BIGSERIAL (llega como string en drivers serverless)
  inventory_id: string;
  order_id: string | null;
  order_item_id: string | null;
  movement_type: InventoryMovementType;
  on_hand_delta: number;
  reserved_delta: number;
  on_hand_after: number;
  reserved_after: number;
  reason: string | null;
  performed_by: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface PickupCodeRow {
  id: string;
  order_id: string;
  code: string;
  locker_code: string | null;
  locker_slot: string | null;
  status: PickupCodeStatus;
  max_attempts: number;
  attempts: number;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderStatusHistoryRow {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_by: string | null;
  reason: string | null;
  created_at: string;
}

// =============================================================================
//  5. TIPOS DE DOMINIO (camelCase, listos para el frontend)
// =============================================================================

export interface ShippingAddress {
  line1: string;
  line2?: string | null;
  district?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null; // default 'PE'
  reference?: string | null;
}

/** Opciones de variante que ya usa el carrito (`selectedColor` / `selectedStorage` en `lib/cartStore.ts`). */
export interface ProductVariant {
  color?: string | null;
  storage?: string | null;
  [key: string]: string | null | undefined;
}

export interface Customer {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  docType: string | null;
  docNumber: string | null;
  authUserId: string | null;
  defaultAddress: ShippingAddress | null;
  marketingOptIn: boolean;
  totalOrders: number;
  totalSpent: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  publicToken: string;
  customerId: string | null;
  contactEmail: string;
  contactPhone: string | null;
  channel: OrderChannel;
  fulfillmentType: FulfillmentType;
  lockerCode: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string | null;
  paymentReference: string | null;
  currency: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  total: number;
  itemCount: number;
  shippingAddress: ShippingAddress | null;
  pickupInstructions: string | null;
  customerNote: string | null;
  reservationExpiresAt: string | null;
  reservationReleased: boolean;
  confirmedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  lineNumber: number;
  productSlug: string;
  productName: string;
  productBrand: string | null;
  imageUrl: string | null;
  variantKey: string;
  variant: ProductVariant;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxAmount: number;
  lineTotal: number;
}

/** Lo que casi siempre quieres pintar: cabecera + líneas. */
export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export interface InventoryItem {
  id: string;
  locationCode: string;
  productSlug: string;
  variantKey: string;
  quantityOnHand: number;
  quantityReserved: number;
  /** Solo lectura: derivado por Postgres. */
  quantityAvailable: number;
  reorderPoint: number;
  restockEta: string | null;
  isActive: boolean;
  updatedAt: string;
}

export interface InventoryMovement {
  id: string;
  inventoryId: string;
  orderId: string | null;
  orderItemId: string | null;
  movementType: InventoryMovementType;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  reason: string | null;
  performedBy: string | null;
  createdAt: string;
}

export interface PickupCode {
  id: string;
  orderId: string;
  code: string;
  lockerCode: string | null;
  lockerSlot: string | null;
  status: PickupCodeStatus;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
  createdAt: string;
}

/** Código vigente + estado del pedido, para la pantalla de retiro. */
export interface PickupCodeWithOrder extends PickupCode {
  orderNumber: string;
  orderStatus: OrderStatus;
}

// =============================================================================
//  6. ENTRADAS DE ESCRITURA (lo que el checkout / admin envía)
// =============================================================================

/** Línea tal como la manda el carrito. El servidor recalcula precios contra el catálogo. */
export interface CreateOrderLineInput {
  productSlug: string;
  productName: string;
  productBrand?: string | null;
  imageUrl?: string | null;
  /** Opciones del carrito (`selectedColor`, `selectedStorage`). */
  variant?: ProductVariant;
  /** Opcional: si no se envía, el servidor lo deriva con `buildVariantKey(variant)`. */
  variantKey?: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxAmount?: number;
}

export interface CreateOrderInput {
  /** Idempotencia del checkout: el mismo valor dos veces devuelve el mismo pedido, no lo duplica. */
  idempotencyKey?: string;
  customerId?: string | null;
  contactEmail: string;
  contactPhone?: string | null;
  channel?: OrderChannel;
  fulfillmentType: FulfillmentType;
  lockerCode?: string | null;
  shippingAddress?: ShippingAddress | null;
  customerNote?: string | null;
  currency?: string;
  shippingTotal?: number;
  /** Sin `payment` en el MVP: el pedido nace en `pending_payment`. */
  reservationTtlMinutes?: number;
  items: CreateOrderLineInput[];
}

export interface NewCustomerInput {
  email: string;
  fullName: string;
  phone?: string | null;
  docType?: string | null;
  docNumber?: string | null;
  authUserId?: string | null;
  defaultAddress?: ShippingAddress | null;
  marketingOptIn?: boolean;
}

/** Alta de un SKU nuevo en el local. Las cantidades SIEMPRE entran por `inventory_apply_movement`. */
export interface InventorySkuInput {
  locationCode?: string;
  productSlug: string;
  variantKey?: string;
  reorderPoint?: number;
  restockEta?: string | null;
  isActive?: boolean;
}

/** Unidades a reservar/liberar. Nunca se envía `quantity_available` (columna generada). */
export interface InventoryDeltaInput {
  locationCode?: string;
  productSlug: string;
  variantKey?: string;
  quantity: number;
  reason?: string;
  performedBy?: string;
  idempotencyKey?: string;
}

// =============================================================================
//  7. CONTRATO DE LAS FUNCIONES SQL (RPC)
// =============================================================================

/**
 * `SELECT * FROM expire_stale_orders(200)` devuelve una columna con el nombre de la función.
 * Números de filas afectadas: pedidos expirados / líneas reservadas / liberadas.
 */
export interface ExpireStaleOrdersResult {
  expire_stale_orders: number;
}
export interface ReserveOrderResult {
  inventory_reserve_order: number;
}
export interface ReleaseOrderResult {
  inventory_release_order: number;
}
export interface CommitOrderResult {
  inventory_commit_order: number;
}
export interface RefreshOrderTotalsResult {
  refresh_order_totals_from_items: OrderRow;
}

/**
 * Resultado exacto de `redeem_pickup_code(code, actor)` (nombres tal cual Postgres).
 *
 * Ojo: el canje fallido NO lanza excepción, porque un RAISE revertiría el contador de
 * intentos. Los fallos llegan en `error_code` (subconjunto de `CommerceErrorCode`:
 * `pickup_code_not_found` | `pickup_code_expired` | `pickup_code_locked` |
 * `pickup_code_already_used`) y el resto de las columnas vienen en NULL.
 */
export interface RedeemPickupCodeResult {
  ok: boolean;
  error_code: CommerceErrorCode | null;
  pickup_code_id: string | null;
  order_id: string | null;
  order_number: string | null;
  locker_code: string | null;
  locker_slot: string | null;
}

// =============================================================================
//  8. ERRORES DEL MOTOR
//     Las funciones PL/pgSQL lanzan con `RAISE EXCEPTION '<code>'`. El cliente
//     sólo tiene el texto del mensaje, así que se clasifica por string.
// =============================================================================

export const COMMERCE_ERROR_CODES = [
  'insufficient_stock',
  'invalid_order_transition',
  'order_items_locked',
  'pickup_code_not_found',
  'pickup_code_expired',
  'pickup_code_locked',
  'pickup_code_already_used',
  'pickup_code_generation_failed',
] as const;
export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

/** Copia para el usuario (el UI del sitio está en inglés). */
export const COMMERCE_ERROR_MESSAGES: Record<CommerceErrorCode, string> = {
  insufficient_stock: 'Sorry, some items just sold out. Please review your cart.',
  invalid_order_transition: 'That status change is not allowed for this order.',
  order_items_locked: 'This order is already confirmed and its items can no longer be edited.',
  pickup_code_not_found: 'We could not find that pickup code.',
  pickup_code_expired: 'This pickup code has expired. Ask staff for help.',
  pickup_code_locked: 'Too many attempts. Ask staff to issue a new code.',
  pickup_code_already_used: 'This code was already used.',
  pickup_code_generation_failed: 'Could not generate a pickup code, please retry.',
};

/** Extrae el código de error del motor a partir del mensaje crudo de Postgres. */
export function classifyCommerceError(error: unknown): CommerceErrorCode | null {
  const message =
    typeof error === 'string'
      ? error
      : ((error as { message?: string } | null | undefined)?.message ?? '');

  return COMMERCE_ERROR_CODES.find((code) => message.includes(code)) ?? null;
}

// =============================================================================
//  9. HELPERS DE DOMINIO
// =============================================================================

/**
 * Clave de SKU que comparten carrito, pedido e inventario.
 * Debe coincidir con lo que persiste `order_items.variant_key`:
 * `buildVariantKey({ color: 'Black Titanium', storage: '256GB' })` → `'color:black titanium|storage:256gb'`.
 */
export function buildVariantKey(variant: ProductVariant = {}): string {
  return Object.entries(variant)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => `${key.toLowerCase()}:${String(value).trim().toLowerCase()}`)
    .sort()
    .join('|');
}

/** Atajo desde las opciones que ya guarda el carrito (`lib/cartStore.ts`). */
export function variantKeyFromCartSelection(selection: {
  selectedColor?: string | null;
  selectedStorage?: string | null;
}): string {
  return buildVariantKey({ color: selection.selectedColor, storage: selection.selectedStorage });
}

export interface OrderTotalsInput {
  items: Pick<CreateOrderLineInput, 'quantity' | 'unitPrice' | 'discountAmount' | 'taxAmount'>[];
  shippingTotal?: number;
  /** Descuento a nivel de pedido (cupones). */
  orderDiscount?: number;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  total: number;
  itemCount: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Total de una línea. Debe coincidir con el CHECK de `order_items`:
 * `line_total = round(quantity * unit_price - discount_amount + tax_amount, 2)`.
 */
export function computeLineTotal(
  line: Pick<CreateOrderLineInput, 'quantity' | 'unitPrice' | 'discountAmount' | 'taxAmount'>,
): number {
  return round2(line.quantity * line.unitPrice - (line.discountAmount ?? 0) + (line.taxAmount ?? 0));
}

/**
 * Calcula los totales de la cabecera.
 *
 * OJO: `orders` tiene el CHECK `total = subtotal - discount_total + tax_total + shipping_total`.
 * Si el checkout calcula el total por su cuenta y no cuadra, el INSERT falla. Usa esto.
 */
export function computeOrderTotals({ items, shippingTotal = 0, orderDiscount = 0 }: OrderTotalsInput): OrderTotals {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const lineDiscounts = items.reduce((sum, item) => sum + (item.discountAmount ?? 0), 0);
  const taxTotal = items.reduce((sum, item) => sum + (item.taxAmount ?? 0), 0);

  return {
    subtotal: round2(subtotal),
    discountTotal: round2(lineDiscounts + orderDiscount),
    taxTotal: round2(taxTotal),
    shippingTotal: round2(shippingTotal),
    total: round2(subtotal - lineDiscounts - orderDiscount + taxTotal + shippingTotal),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

// =============================================================================
//  10. MAPPERS fila → dominio
// =============================================================================

const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : typeof value === 'number' ? value : Number(value);

export const toCustomer = (row: CustomerRow): Customer => ({
  id: row.id,
  email: row.email,
  phone: row.phone,
  fullName: row.full_name,
  docType: row.doc_type,
  docNumber: row.doc_number,
  authUserId: row.auth_user_id,
  defaultAddress: row.default_address,
  marketingOptIn: row.marketing_opt_in,
  totalOrders: row.total_orders,
  totalSpent: num(row.total_spent),
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export const toOrder = (row: OrderRow): Order => ({
  id: row.id,
  orderNumber: row.order_number,
  publicToken: row.public_token,
  customerId: row.customer_id,
  contactEmail: row.contact_email,
  contactPhone: row.contact_phone,
  channel: row.channel,
  fulfillmentType: row.fulfillment_type,
  lockerCode: row.locker_code,
  status: row.status,
  paymentStatus: row.payment_status,
  paymentMethod: row.payment_method,
  paymentReference: row.payment_reference,
  currency: row.currency,
  subtotal: num(row.subtotal),
  discountTotal: num(row.discount_total),
  taxTotal: num(row.tax_total),
  shippingTotal: num(row.shipping_total),
  total: num(row.total),
  itemCount: row.item_count,
  shippingAddress: row.shipping_address,
  pickupInstructions: row.pickup_instructions,
  customerNote: row.customer_note,
  reservationExpiresAt: row.reservation_expires_at,
  reservationReleased: row.reservation_released,
  confirmedAt: row.confirmed_at,
  readyAt: row.ready_at,
  pickedUpAt: row.picked_up_at,
  deliveredAt: row.delivered_at,
  cancelledAt: row.cancelled_at,
  cancelledReason: row.cancelled_reason,
  metadata: row.metadata,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toOrderItem = (row: OrderItemRow): OrderItem => ({
  id: row.id,
  orderId: row.order_id,
  lineNumber: row.line_number,
  productSlug: row.product_slug,
  productName: row.product_name,
  productBrand: row.product_brand,
  imageUrl: row.image_url,
  variantKey: row.variant_key,
  variant: row.variant,
  quantity: row.quantity,
  unitPrice: num(row.unit_price),
  discountAmount: num(row.discount_amount),
  taxAmount: num(row.tax_amount),
  lineTotal: num(row.line_total),
});

export const toOrderWithItems = (row: OrderRow, items: OrderItemRow[]): OrderWithItems => ({
  ...toOrder(row),
  items: items.map(toOrderItem),
});

export const toInventoryItem = (row: InventoryRow): InventoryItem => ({
  id: row.id,
  locationCode: row.location_code,
  productSlug: row.product_slug,
  variantKey: row.variant_key,
  quantityOnHand: row.quantity_on_hand,
  quantityReserved: row.quantity_reserved,
  quantityAvailable: row.quantity_available,
  reorderPoint: row.reorder_point,
  restockEta: row.restock_eta,
  isActive: row.is_active,
  updatedAt: row.updated_at,
});

export const toInventoryMovement = (row: InventoryMovementRow): InventoryMovement => ({
  id: row.id,
  inventoryId: row.inventory_id,
  orderId: row.order_id,
  orderItemId: row.order_item_id,
  movementType: row.movement_type,
  onHandDelta: row.on_hand_delta,
  reservedDelta: row.reserved_delta,
  onHandAfter: row.on_hand_after,
  reservedAfter: row.reserved_after,
  reason: row.reason,
  performedBy: row.performed_by,
  createdAt: row.created_at,
});

export const toPickupCode = (row: PickupCodeRow): PickupCode => ({
  id: row.id,
  orderId: row.order_id,
  code: row.code,
  lockerCode: row.locker_code,
  lockerSlot: row.locker_slot,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  expiresAt: row.expires_at,
  redeemedAt: row.redeemed_at,
  redeemedBy: row.redeemed_by,
  createdAt: row.created_at,
});

/** Código emitido + datos del pedido para la pantalla de retiro del Locker. */
export const toPickupCodeWithOrder = (
  code: PickupCodeRow,
  order: Pick<OrderRow, 'order_number' | 'status'>,
): PickupCodeWithOrder => ({
  ...toPickupCode(code),
  orderNumber: order.order_number,
  orderStatus: order.status,
});

/**
 * Resultado del RPC `redeem_pickup_code`. Devuelve `null` si el canje no prosperó
 * (en ese caso lee `row.error_code` y tradúcelo con `COMMERCE_ERROR_MESSAGES`).
 *
 * `orderStatus` se reporta como 'picked_up': la base solo avanza el pedido si estaba
 * en `ready_for_pickup`; si no, emite un NOTICE para que operación lo revise.
 */
export const toRedeemedPickup = (row: RedeemPickupCodeResult): PickupCodeWithOrder | null => {
  if (!row.ok || !row.pickup_code_id || !row.order_id) return null;

  return {
    id: row.pickup_code_id,
    orderId: row.order_id,
    orderNumber: row.order_number ?? '',
    orderStatus: 'picked_up',
    code: '',
    lockerCode: row.locker_code,
    lockerSlot: row.locker_slot,
    status: 'redeemed',
    attempts: 0,
    maxAttempts: 0,
    expiresAt: '',
    redeemedAt: new Date().toISOString(),
    redeemedBy: null,
    createdAt: '',
  };
};
