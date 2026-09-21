/**
 * lib/commerce.server.ts — Motor transaccional (Fase 1): capa de acceso a datos.
 *
 * Este archivo SOLO se ejecuta en el servidor (route handlers, Server Components,
 * crons). Nunca lo importes desde un componente cliente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ¿POR QUÉ UN CLIENTE PROPIO Y NO EL `sql` DE `lib/db.ts`?
 *
 *  `lib/db.ts` envuelve el tagged template con `.then(...)` para devolver el
 *  viejo shape `{ rows }`. Esa envoltura convierte la consulta en una Promise
 *  común, y el driver de Neon necesita el objeto de consulta interno para poder
 *  agrupar varias en UNA transacción (`sql.transaction([...])`).
 *
 *  Crear un pedido NO es una sola sentencia: es
 *    INSERT orders + INSERT order_items (N) + inventory_reserve_order()
 *  y tiene que ser atómico — si la reserva falla por falta de stock, el pedido
 *  no debe quedar creado. Por eso aquí instanciamos `neon()` directamente y
 *  usamos `transaction()` (una transacción no interactiva sobre HTTP, ideal para
 *  el runtime de Cloudflare/OpenNext donde desplegamos).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Reglas que respeta esta capa:
 *   · La base es la autoridad: las transiciones de estado las valida el trigger
 *     `enforce_order_status_transition`, no JavaScript.
 *   · El stock SIEMPRE entra por `inventory_apply_movement()` (nunca UPDATE directo).
 *   · La idempotencia del checkout la garantiza el índice único de `orders.idempotency_key`.
 */

import { neon } from '@neondatabase/serverless';
import { envConfig } from './env';
import {
  buildVariantKey,
  computeLineTotal,
  computeOrderTotals,
  toInventoryItem,
  toInventoryMovement,
  toKioskOrderSummary,
  toOrder,
  toOrderWithItems,
  toPickupCode,
  type CreateOrderInput,
  type InventoryItem,
  type InventoryMovement,
  type InventoryMovementType,
  type InventoryMovementRow,
  type InventoryRow,
  type KioskQueue,
  type KioskQueueRow,
  type Order,
  type OrderItemRow,
  type OrderRow,
  type OrderStatus,
  type OrderWithItems,
  type PickupCode,
  type PickupCodeRow,
  type ProductVariant,
  type RedeemPickupCodeResult,
} from './commerce';

// =============================================================================
//  0. CLIENTE Y GUARDS
// =============================================================================

type NeonQuery = ReturnType<typeof neon>;

let cachedSql: NeonQuery | null = null;

/** Cadena de conexión efectiva (respeta los prefijos de Vercel vía `envConfig`). */
function resolveDatabaseUrl(): string | undefined {
  return envConfig.database.nonPoolingUrl || envConfig.database.url || undefined;
}

/** ¿Hay base de datos configurada? (para que la ruta devuelva 503 en vez de explotar). */
export function isCommerceDbConfigured(): boolean {
  return !!resolveDatabaseUrl();
}

function getCommerceSql(): NeonQuery | null {
  const url = resolveDatabaseUrl();
  if (!url) return null;
  // Caché por instancia: en serverless la instancia vive poco, así que es seguro.
  if (!cachedSql) cachedSql = neon(url);
  return cachedSql;
}

function requireSql(): NeonQuery {
  const sql = getCommerceSql();
  if (!sql) throw new Error('commerce_db_not_configured');
  return sql;
}

/**
 * El guard `prevent_ledger_mutation()` hace el ledger append-only; Postgres
 * responde con SQLSTATE 23505 en un choque de índice único (idempotencia).
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === '23505') return true;
  const message = (error as { message?: string } | null | undefined)?.message ?? '';
  return message.includes('duplicate key value violates unique constraint');
}

/** Resultado crudo de `sql.transaction()`: un array de arrays de filas. */
type TransactionResults = Array<Array<Record<string, unknown>>>;

/** Tipa el resultado en la posición `index` de un batch de `sql.transaction()`. */
function rowsAt<T>(results: TransactionResults, index: number): T[] {
  return (results[index] ?? []) as unknown as T[];
}

/** Primera fila del resultado en la posición `index` (o `undefined` si vino vacío). */
function rowAt<T>(results: TransactionResults, index: number): T | undefined {
  return rowsAt<T>(results, index)[0];
}

// =============================================================================
//  1. PEDIDOS — ESCRITURA
// =============================================================================

const DEFAULT_RESERVATION_TTL_MINUTES = 30;

export interface CreateOrderOptions {
  /** Se guarda tal cual en `orders.metadata` (datos de invitado, DNI para Mercado Pago, etc.). */
  metadata?: Record<string, unknown>;
  /** Local/locker donde se retiene el stock. */
  locationCode?: string;
}

/**
 * Crea un pedido completo y reserva su stock en UNA transacción.
 *
 * Orden de las sentencias (importa):
 *   1. INSERT orders            → nace en `pending_payment`, ya con los totales cuadrados.
 *   2. INSERT order_items       → snapshot de nombre/precio (el precio lo recalcula el servidor).
 *   3. inventory_reserve_order  → retiene stock; si falta, la transacción completa se revierte
 *                                 y el pedido NUNCA queda creado.
 *
 * Idempotencia: si llega `idempotencyKey`, un reintento devuelve el pedido existente
 * en vez de duplicarlo (doble clic en "Pagar", reintento de red, etc.).
 */
export async function createOrder(
  input: CreateOrderInput,
  options: CreateOrderOptions = {},
): Promise<OrderWithItems> {
  const sql = requireSql();

  // Camino rápido de idempotencia: ya existe un pedido con esta clave.
  if (input.idempotencyKey) {
    const existing = await getOrderByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
  }

  if (input.items.length === 0) {
    throw new Error('createOrder: se requiere al menos una línea');
  }

  // Generamos el UUID en el servidor para poder referenciarlo desde las N sentencias
  // del batch (dentro de una transacción no podemos leer el RETURNING de una antes
  // de construir la siguiente).
  const orderId = crypto.randomUUID();

  const lines = input.items.map((line) => {
    const variant: ProductVariant = line.variant ?? {};
    const discountAmount = line.discountAmount ?? 0;
    const taxAmount = line.taxAmount ?? 0;

    return {
      productSlug: line.productSlug,
      productName: line.productName,
      productBrand: line.productBrand ?? null,
      imageUrl: line.imageUrl ?? null,
      variant,
      variantKey: line.variantKey ?? buildVariantKey(variant),
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount,
      taxAmount,
      lineTotal: computeLineTotal({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount,
        taxAmount,
      }),
    };
  });

  // Mismo cálculo que valida el CHECK `orders_total_balanced_chk`. Si la matemática de
  // acá no cuadra con la de Postgres, el INSERT falla en vez de guardar un total corrupto.
  const totals = computeOrderTotals({
    items: lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      taxAmount: line.taxAmount,
    })),
    shippingTotal: input.shippingTotal ?? 0,
  });

  const ttlMinutes = input.reservationTtlMinutes ?? DEFAULT_RESERVATION_TTL_MINUTES;
  const metadata = {
    source: 'checkout',
    ...(options.metadata ?? {}),
  };

  const orderStatement = sql`
    INSERT INTO orders (
      id, idempotency_key, customer_id, contact_email, contact_phone,
      channel, fulfillment_type, locker_code,
      status, payment_status, currency,
      subtotal, discount_total, tax_total, shipping_total, total, item_count,
      shipping_address, customer_note, reservation_expires_at, metadata
    ) VALUES (
      ${orderId}::uuid,
      ${input.idempotencyKey ?? null},
      ${input.customerId ?? null}::uuid,
      ${input.contactEmail},
      ${input.contactPhone ?? null},
      ${input.channel ?? 'web'}::order_channel,
      ${input.fulfillmentType}::fulfillment_type,
      ${input.lockerCode ?? null},
      'pending_payment'::order_status,
      'pending'::payment_status,
      ${input.currency ?? 'PEN'},
      ${totals.subtotal}, ${totals.discountTotal}, ${totals.taxTotal},
      ${totals.shippingTotal}, ${totals.total}, ${totals.itemCount},
      ${input.shippingAddress ? JSON.stringify(input.shippingAddress) : null}::jsonb,
      ${input.customerNote ?? null},
      NOW() + make_interval(mins => ${ttlMinutes}::int),
      ${JSON.stringify(metadata)}::jsonb
    )
    RETURNING *
  `;

  const itemStatements = lines.map(
    (line, index) => sql`
      INSERT INTO order_items (
        order_id, line_number, product_slug, product_name, product_brand, image_url,
        variant_key, variant, quantity, unit_price, discount_amount, tax_amount, line_total
      ) VALUES (
        ${orderId}::uuid,
        ${index + 1},
        ${line.productSlug},
        ${line.productName},
        ${line.productBrand},
        ${line.imageUrl},
        ${line.variantKey},
        ${JSON.stringify(line.variant)}::jsonb,
        ${line.quantity},
        ${line.unitPrice},
        ${line.discountAmount},
        ${line.taxAmount},
        ${line.lineTotal}
      )
      RETURNING *
    `,
  );

  const reserveStatement = sql`
    SELECT inventory_reserve_order(
      ${orderId}::uuid,
      ${options.locationCode ?? 'MAIN'}
    ) AS reserved_lines
  `;

  let results: TransactionResults;
  try {
    results = (await sql.transaction([
      orderStatement,
      ...itemStatements,
      reserveStatement,
    ])) as unknown as TransactionResults;
  } catch (error) {
    // Carrera de idempotencia: otra request con la misma clave ganó. Devolvemos la suya.
    if (input.idempotencyKey && isUniqueViolation(error)) {
      const existing = await getOrderByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
    // `insufficient_stock`, `invalid_order_transition`, etc. suben tal cual para que la
    // ruta las traduzca con `classifyCommerceError()` + `COMMERCE_ERROR_MESSAGES`.
    throw error;
  }

  const orderRow = rowAt<OrderRow>(results, 0);
  if (!orderRow) {
    throw new Error('createOrder: el INSERT de orders no devolvió fila');
  }

  const itemRows = results.slice(1, 1 + lines.length).flat() as unknown as OrderItemRow[];
  return toOrderWithItems(orderRow, itemRows);
}

/**
 * Guarda el snapshot de la Preference de Mercado Pago dentro de `orders.metadata`.
 *
 * Se hace `||` sobre `metadata -> 'payment'` para no pisar otras claves de metadata
 * (el `buyer` del checkout, etc.). No toca `status`/`payment_status`, así que el
 * trigger de transiciones no se interpone.
 */
export async function saveOrderPaymentPreference(
  orderId: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const sql = requireSql();

  await sql`
    UPDATE orders
       SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{payment}',
             COALESCE(metadata -> 'payment', '{}'::jsonb) || ${JSON.stringify(snapshot)}::jsonb,
             true
           )
     WHERE id = ${orderId}::uuid
  `;
}

// =============================================================================
//  2. PEDIDOS — LECTURA
// =============================================================================

/** Pedido + líneas por id (UUID interno). */
export async function getOrderWithItems(orderId: string): Promise<OrderWithItems | null> {
  const sql = requireSql();

  const results = (await sql.transaction(
    [
      sql`SELECT * FROM orders WHERE id = ${orderId}::uuid LIMIT 1`,
      sql`SELECT * FROM order_items WHERE order_id = ${orderId}::uuid ORDER BY line_number`,
    ],
    { readOnly: true },
  )) as unknown as TransactionResults;

  const orderRow = rowAt<OrderRow>(results, 0);
  if (!orderRow) return null;

  return toOrderWithItems(orderRow, (results[1] ?? []) as unknown as OrderItemRow[]);
}

/**
 * Pedido por `public_token`: es el enlace público que se le puede dar al invitado
 * (`/pedido/<token>`) sin exponer su UUID interno.
 */
export async function getOrderByPublicToken(token: string): Promise<OrderWithItems | null> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM orders WHERE public_token = ${token}::uuid LIMIT 1
  `) as unknown as OrderRow[];

  const orderRow = rows[0];
  if (!orderRow) return null;

  return getOrderWithItems(orderRow.id);
}

/** Usada por el camino de idempotencia del checkout. */
export async function getOrderByIdempotencyKey(key: string): Promise<OrderWithItems | null> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM orders WHERE idempotency_key = ${key} LIMIT 1
  `) as unknown as OrderRow[];

  const orderRow = rows[0];
  if (!orderRow) return null;

  return getOrderWithItems(orderRow.id);
}

/** Historial de auditoría de estados, más reciente primero. */
export async function getOrderStatusHistory(orderId: string) {
  const sql = requireSql();
  return (await sql`
    SELECT * FROM order_status_history
     WHERE order_id = ${orderId}::uuid
     ORDER BY created_at DESC
  `) as unknown as Array<{
    id: string;
    order_id: string;
    from_status: OrderStatus | null;
    to_status: OrderStatus;
    changed_by: string | null;
    reason: string | null;
    created_at: string;
  }>;
}

// =============================================================================
//  3. PEDIDOS — MÁQUINA DE ESTADOS
//
//  La validación vive en el trigger; acá solo escribimos intención. Si la
//  transición no está en `order_status_transitions`, Postgres la rechaza con
//  `invalid_order_transition` y nosotros la traducimos en la ruta.
// =============================================================================

/**
 * Cambia el estado y deja que el trigger selle los hitos (`confirmed_at`, `ready_at`, …).
 * `actor` queda registrado en `order_status_history.changed_by` vía `app.actor`.
 */
export async function transitionOrderStatus(
  orderId: string,
  to: OrderStatus,
  options: { actor?: string } = {},
): Promise<Order> {
  const sql = requireSql();

  const results = (await sql.transaction([
    // `true` = alcance de transacción: muere al hacer COMMIT.
    sql`SELECT set_config('app.actor', ${options.actor ?? 'system'}, true)`,
    sql`
      UPDATE orders
         SET status = ${to}::order_status
       WHERE id = ${orderId}::uuid
      RETURNING *
    `,
  ])) as unknown as TransactionResults;

  const orderRow = rowAt<OrderRow>(results, 1);
  if (!orderRow) throw new Error(`transitionOrderStatus: pedido ${orderId} no encontrado`);
  return toOrder(orderRow);
}

/**
 * Cancela el pedido y libera el stock retenido, atómicamente.
 *
 * `inventory_release_order()` es un no-op si no hay reserva viva, así que se puede
 * llamar sin condiciones. Si el cambio de estado fuera inválido, el rollback también
 * revierte la liberación de stock (nunca queda stock "liberado" en un pedido vivo).
 */
export async function cancelOrder(
  orderId: string,
  options: { reason?: string; actor?: string } = {},
): Promise<Order> {
  const sql = requireSql();
  const reason = options.reason ?? 'cancelled_by_user';

  const results = (await sql.transaction([
    sql`SELECT set_config('app.actor', ${options.actor ?? 'system'}, true)`,
    sql`SELECT inventory_release_order(${orderId}::uuid, ${reason}) AS released_lines`,
    sql`
      UPDATE orders
         SET status = 'cancelled'::order_status,
             cancelled_reason = ${reason}
       WHERE id = ${orderId}::uuid
      RETURNING *
    `,
  ])) as unknown as TransactionResults;

  const orderRow = rowAt<OrderRow>(results, 2);
  if (!orderRow) throw new Error(`cancelOrder: pedido ${orderId} no encontrado`);
  return toOrder(orderRow);
}

/**
 * Marca el pedido como listo para retirar y emite su PIN, en una sola transacción:
 * no puede existir un PIN sin pedido listo, ni un pedido listo sin PIN.
 *
 * Toda la lógica vive en `mark_order_ready_for_pickup()` (migración 003) por dos
 * razones:
 *   · La máquina de estados NO permite `confirmed → ready_for_pickup`: hay que pasar
 *     por `preparing`. Hacerlo desde acá serían dos transacciones y un estado
 *     intermedio visible si la segunda falla.
 *   · La base exige `payment_status = 'paid'`: sin esa barrera, un camino nuevo a
 *     `ready_for_pickup` podría preparar mercadería impaga.
 *
 * Lanza `invalid_order_transition` u `order_not_paid` (traducibles con
 * `classifyCommerceError()`).
 */
export async function markReadyForPickup(
  orderId: string,
  options: {
    lockerCode?: string | null;
    lockerSlot?: string | null;
    ttlDays?: number;
    maxAttempts?: number;
    actor?: string;
  } = {},
): Promise<PickupCode> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM mark_order_ready_for_pickup(
      ${orderId}::uuid,
      ${options.lockerCode ?? null},
      ${options.lockerSlot ?? null},
      make_interval(days => ${options.ttlDays ?? 7}::int),
      ${options.maxAttempts ?? 5},
      ${options.actor ?? 'system'}
    )
  `) as unknown as PickupCodeRow[];

  const codeRow = rows[0];
  if (!codeRow) throw new Error(`markReadyForPickup: no se pudo emitir código para ${orderId}`);
  return toPickupCode(codeRow);
}

/** La reserva se convierte en salida real de stock recién al retirar. */
export async function markPickedUp(
  orderId: string,
  options: { reason?: string; actor?: string } = {},
): Promise<Order> {
  return commitAndTransition(orderId, 'picked_up', options);
}

export async function markDelivered(
  orderId: string,
  options: { reason?: string; actor?: string } = {},
): Promise<Order> {
  return commitAndTransition(orderId, 'delivered', options);
}

async function commitAndTransition(
  orderId: string,
  to: Extract<OrderStatus, 'picked_up' | 'delivered'>,
  options: { reason?: string; actor?: string },
): Promise<Order> {
  const sql = requireSql();

  const results = (await sql.transaction([
    sql`SELECT set_config('app.actor', ${options.actor ?? 'system'}, true)`,
    sql`SELECT inventory_commit_order(${orderId}::uuid, ${options.reason ?? to}) AS committed_lines`,
    sql`
      UPDATE orders
         SET status = ${to}::order_status
       WHERE id = ${orderId}::uuid
      RETURNING *
    `,
  ])) as unknown as TransactionResults;

  const orderRow = rowAt<OrderRow>(results, 2);
  if (!orderRow) throw new Error(`commitAndTransition: pedido ${orderId} no encontrado`);
  return toOrder(orderRow);
}

// =============================================================================
//  3.b CONFIRMACIÓN DE PAGO (webhook de Mercado Pago)
//
//  Toda la lógica vive en `confirm_order_payment()` (migración 002) porque tiene
//  que ser UNA unidad atómica: bloquear el pedido, re-reservar el stock liberado
//  por el reaper y confirmar. Desde JavaScript eso son varias sentencias sobre
//  HTTP y no hay forma de que sean atómicas entre sí.
// =============================================================================

export interface ConfirmOrderPaymentInput {
  /** `orders.order_number`, que viaja como `payment.external_reference`. */
  orderNumber: string;
  /** Id del pago en Mercado Pago (queda en `orders.payment_reference`). */
  paymentId: string;
  paymentMethod?: string | null;
  /** Monto que MP dice haber cobrado. Se valida contra `orders.total` en la base. */
  paidAmount?: number | null;
  currency?: string | null;
  /** Snapshot del pago para `metadata.payment` (status, status_detail, fecha…). */
  paymentMetadata?: Record<string, unknown>;
  locationCode?: string;
  actor?: string;
}

/**
 * Confirma el pago de un pedido y devuelve su estado final.
 *
 * Es idempotente: si el pedido ya estaba pagado, devuelve el pedido sin tocar nada.
 * Devuelve `null` si el `order_number` no existe en esta base (típicamente un pago
 * de sandbox llegando a producción).
 *
 * Lee `readOrderPaymentAudit()` sobre el pedido devuelto para saber si el cobro
 * quedó pendiente de revisión o si hubo conflicto de stock.
 */
export async function confirmOrderPayment(
  input: ConfirmOrderPaymentInput,
): Promise<Order | null> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM confirm_order_payment(
      ${input.orderNumber},
      ${input.paymentId},
      ${input.paymentMethod ?? null},
      ${input.paidAmount ?? null},
      ${input.currency ?? null},
      ${JSON.stringify(input.paymentMetadata ?? {})}::jsonb,
      ${input.locationCode ?? 'MAIN'},
      ${input.actor ?? 'mercadopago:webhook'}
    )
  `) as unknown as OrderRow[];

  const row = rows[0];
  return row ? toOrder(row) : null;
}

// =============================================================================
//  4. INVENTARIO
//
//  Único camino sancionado para tocar stock. NUNCA hagas UPDATE directo sobre
//  `inventory`: te saltarías las 3 capas anti-sobreventa y el ledger.
// =============================================================================

export interface InventoryMovementInput {
  productSlug: string;
  variantKey?: string;
  movementType: InventoryMovementType;
  onHandDelta?: number;
  reservedDelta?: number;
  locationCode?: string;
  orderId?: string | null;
  orderItemId?: string | null;
  reason?: string | null;
  performedBy?: string | null;
  /** Capa 3: un reintento con la misma clave devuelve el movimiento existente, no lo duplica. */
  idempotencyKey?: string | null;
}

export async function applyInventoryMovement(
  input: InventoryMovementInput,
): Promise<InventoryMovement> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM inventory_apply_movement(
      ${input.productSlug},
      ${input.variantKey ?? ''},
      ${input.movementType}::inventory_movement_type,
      ${input.onHandDelta ?? 0},
      ${input.reservedDelta ?? 0},
      ${input.locationCode ?? 'MAIN'},
      ${input.orderId ?? null}::uuid,
      ${input.orderItemId ?? null}::uuid,
      ${input.reason ?? null},
      ${input.performedBy ?? null},
      ${input.idempotencyKey ?? null}
    )
  `) as unknown as InventoryMovementRow[];

  const row = rows[0];
  if (!row) throw new Error('applyInventoryMovement: la función no devolvió movimiento');
  return toInventoryMovement(row);
}

/** Retiene stock de todas las líneas del pedido. Devuelve cuántas líneas reservó. */
export async function reserveOrderStock(orderId: string, locationCode = 'MAIN'): Promise<number> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT inventory_reserve_order(${orderId}::uuid, ${locationCode}) AS reserved_lines
  `) as unknown as Array<{ reserved_lines: number }>;
  return Number(rows[0]?.reserved_lines ?? 0);
}

/** Libera lo retenido (cancelación / expiración). No-op si ya se vendió. */
export async function releaseOrderStock(
  orderId: string,
  reason = 'cancelled',
): Promise<number> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT inventory_release_order(${orderId}::uuid, ${reason}) AS released_lines
  `) as unknown as Array<{ released_lines: number }>;
  return Number(rows[0]?.released_lines ?? 0);
}

/** Convierte la reserva en venta (el stock sale físico). */
export async function commitOrderStock(orderId: string, reason = 'picked_up'): Promise<number> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT inventory_commit_order(${orderId}::uuid, ${reason}) AS committed_lines
  `) as unknown as Array<{ committed_lines: number }>;
  return Number(rows[0]?.committed_lines ?? 0);
}

/** Stock de un SKU concreto (`quantity_available` lo deriva Postgres). */
export async function getInventoryItem(
  productSlug: string,
  variantKey = '',
  locationCode = 'MAIN',
): Promise<InventoryItem | null> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM inventory
     WHERE location_code = ${locationCode}
       AND product_slug = ${productSlug}
       AND variant_key = ${variantKey}
     LIMIT 1
  `) as unknown as InventoryRow[];

  return rows[0] ? toInventoryItem(rows[0]) : null;
}

/**
 * Re-reserva el stock de un pedido cuya reserva ya había liberado el reaper
 * (pago tardío de Mercado Pago). Sólo retiene las líneas que hoy no lo están.
 *
 * NO uses `reserveOrderStock()` para esto: reutiliza la clave de idempotencia
 * `reserve:<order>:<item>`, que ya existe en el ledger, y el motor devolvería el
 * movimiento viejo sin retener nada.
 */
export async function rereserveOrderStock(orderId: string, locationCode = 'MAIN'): Promise<number> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT inventory_rereserve_order(${orderId}::uuid, ${locationCode}) AS rereserved_lines
  `) as unknown as Array<{ rereserved_lines: number }>;
  return Number(rows[0]?.rereserved_lines ?? 0);
}

/**
 * Reaper de reservas vencidas. Engánchalo a un cron (Vercel Cron / GitHub Action)
 * cada minuto: libera stock de pedidos `pending_payment` sin pagar y los marca `expired`.
 */
export async function expireStaleOrders(limit = 100): Promise<number> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT expire_stale_orders(${limit}) AS expired_orders
  `) as unknown as Array<{ expired_orders: number }>;
  return Number(rows[0]?.expired_orders ?? 0);
}

// =============================================================================
//  5. LOCKER (códigos de retiro)
// =============================================================================

export async function issuePickupCode(
  orderId: string,
  options: {
    lockerCode?: string | null;
    lockerSlot?: string | null;
    ttlDays?: number;
    maxAttempts?: number;
  } = {},
): Promise<PickupCode> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM issue_pickup_code(
      ${orderId}::uuid,
      ${options.lockerCode ?? null},
      ${options.lockerSlot ?? null},
      make_interval(days => ${options.ttlDays ?? 7}::int),
      ${options.maxAttempts ?? 5}
    )
  `) as unknown as PickupCodeRow[];

  const row = rows[0];
  if (!row) throw new Error('issuePickupCode: no se pudo generar el código');
  return toPickupCode(row);
}

export interface RedeemPickupCodeInput {
  code: string;
  /** Quién retira: `'kiosk:<device>'`, `'admin:jane'`… Queda en `pickup_codes.redeemed_by`. */
  redeemedBy?: string | null;
  /** Identificador del terminal. Alimenta el freno de intentos y la auditoría. */
  deviceId?: string | null;
  ip?: string | null;
}

/**
 * Canje del PIN en el kiosco: frena, canjea y CONSOLIDA el inventario, atómicamente.
 *
 * OJO: los fallos NO lanzan excepción — un RAISE revertiría el registro del intento, y
 * ese registro es justamente el freno anti-fuerza-bruta. Los fallos llegan en
 * `error_code`; revisa `ok`.
 *
 * Usa `redeem_pickup_code_verified()` (migración 003) y NO `redeem_pickup_code()`
 * directo: esa última marca el pedido `picked_up` pero nunca llama a
 * `inventory_commit_order()`, así que la reserva jamás se convierte en salida real y
 * `quantity_on_hand` queda inflado para siempre.
 *
 * Si el commit de stock falla (la reserva ya no estaba), la transacción completa se
 * revierte: el PIN vuelve a ser válido y el pedido sigue listo. Nunca un PIN
 * consumido con el stock todavía retenido.
 */
export async function redeemPickupCode(
  input: RedeemPickupCodeInput,
): Promise<RedeemPickupCodeResult> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM redeem_pickup_code_verified(
      ${input.code},
      ${input.redeemedBy ?? null},
      ${input.deviceId ?? null},
      ${input.ip ?? null}
    )
  `) as unknown as RedeemPickupCodeResult[];

  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      error_code: 'pickup_code_not_found',
      pickup_code_id: null,
      order_id: null,
      order_number: null,
      locker_code: null,
      locker_slot: null,
      committed_lines: 0,
    };
  }
  return row;
}

/**
 * Todo lo que necesita la pantalla del kiosco, en una sola lectura.
 *
 * `ready`    → pedidos con PIN vigente y pedido `ready_for_pickup`.
 * `preparing` → pagados y todavía sin preparar (la operaria los marca listos).
 *
 * Se filtra `payment_status = 'paid'` en las dos: la cola del kiosco no debe mostrar
 * pedidos impagos, aunque la base ya lo impida al emitir el PIN.
 */
export async function getKioskQueue(limit = 50): Promise<KioskQueue> {
  const sql = requireSql();

  // El resumen de items va como subconsulta correlacionada (y no con un GROUP BY sobre
  // toda la consulta) para no arrastrar las columnas de `orders` a la agregación.
  // Está escrito dos veces a propósito: reutilizar el MISMO fragmento `sql` en dos
  // consultas distintas es apoyarse en cómo el driver arma las dinámicas, y no vale la
  // pena arriesgar el comportamiento por ahorrar tres líneas de SQL.
  const results = await sql.transaction(
    [
      sql`
        SELECT o.id, o.order_number, o.status, o.fulfillment_type,
               COALESCE(pc.locker_code, o.locker_code) AS locker_code,
               pc.locker_slot AS locker_slot,
               o.metadata -> 'buyer' ->> 'fullName' AS buyer_name,
               o.contact_email, o.contact_phone, o.item_count, o.total, o.currency,
               o.ready_at, pc.expires_at AS code_expires_at,
               (SELECT string_agg(oi.product_name || ' ×' || oi.quantity, ' · ' ORDER BY oi.line_number)
                  FROM order_items oi
                 WHERE oi.order_id = o.id) AS item_summary
          FROM orders o
          LEFT JOIN LATERAL (
            SELECT c.locker_code, c.locker_slot, c.expires_at
              FROM pickup_codes c
             WHERE c.order_id = o.id AND c.status = 'issued'
             ORDER BY c.created_at DESC
             LIMIT 1
          ) pc ON TRUE
         WHERE o.status = 'ready_for_pickup'
         ORDER BY o.ready_at NULLS LAST, o.created_at
         LIMIT ${limit}
      `,
      sql`
        SELECT o.id, o.order_number, o.status, o.fulfillment_type,
               o.locker_code,
               NULL::TEXT AS locker_slot,
               o.metadata -> 'buyer' ->> 'fullName' AS buyer_name,
               o.contact_email, o.contact_phone, o.item_count, o.total, o.currency,
               o.ready_at,
               NULL::TIMESTAMPTZ AS code_expires_at,
               (SELECT string_agg(oi.product_name || ' ×' || oi.quantity, ' · ' ORDER BY oi.line_number)
                  FROM order_items oi
                 WHERE oi.order_id = o.id) AS item_summary
          FROM orders o
         WHERE o.status IN ('confirmed', 'preparing')
           AND o.payment_status = 'paid'
         ORDER BY o.confirmed_at NULLS LAST, o.created_at
         LIMIT ${limit}
      `,
    ],
    { readOnly: true },
  );

  return {
    ready: rowsAt<KioskQueueRow>(results as TransactionResults, 0).map(toKioskOrderSummary),
    preparing: rowsAt<KioskQueueRow>(results as TransactionResults, 1).map(toKioskOrderSummary),
  };
}

/** Código vigente de un pedido (para la pantalla de retiro del cliente). */
export async function getIssuedPickupCode(orderId: string): Promise<PickupCode | null> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM pickup_codes
     WHERE order_id = ${orderId}::uuid
       AND status = 'issued'
     ORDER BY created_at DESC
     LIMIT 1
  `) as unknown as PickupCodeRow[];

  return rows[0] ? toPickupCode(rows[0]) : null;
}
