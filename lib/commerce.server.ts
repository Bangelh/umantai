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
  type PaymentStatus,
  type PickupCode,
  type PickupCodeRow,
  type ProductVariant,
  type RedeemPickupCodeResult,
} from './commerce';
import type { PaymentWebhookEventRecord } from './payment-webhook-observability';
import {
  toAdminOrderView,
  toAdminReservationHolderView,
  type AdminInventoryMovementView,
  type AdminOrderView,
  type AdminReservationHolderView,
  type AdminReservationLineInput,
} from './admin-order-view';
import {
  classifyReservationLines,
  reconcileReservedDeltas,
  type InventoryMovementAudit,
  type ReservationLineAudit,
  type ReservedReconciliation,
} from './inventory-audit';

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

/**
 * SQLSTATE 40P01 — Postgres abortó una transacción por deadlock detectado.
 *
 * En este sistema el deadlock es posible entre dos transacciones que toman las
 * MISMAS filas de `inventory` en órdenes distintos:
 *   · dos `createOrder` cuyos carritos listan los SKUs en distinto `line_number`
 *     (el carrito A reserva [X, Y] y el B [Y, X]);
 *   · un `createOrder` contra el reaper (`expire_stale_orders`), que bloquea
 *     primero `orders` y después `inventory`.
 *
 * Postgres ya eligió a la víctima y revirtió su transacción COMPLETA, así que
 * reintentar es seguro: no hay escritura parcial y se vuelve a emitir el mismo
 * lote. Es la ÚNICA clase de error que reintentamos.
 */
const DEADLOCK_DETECTED = '40P01';

/** Intentos totales por operación: 1 intento + 1 reintento. Deliberadamente bajo. */
const DEADLOCK_MAX_ATTEMPTS = 2;

/** Espera entre intentos (un deadlock se resuelve en cuanto la otra transacción cae). */
const DEADLOCK_RETRY_DELAY_MS = 40;

/** ¿El error es un deadlock de Postgres? (por SQLSTATE y, si no viene, por mensaje). */
export function isDeadlockError(error: unknown): boolean {
  if ((error as { code?: string } | null | undefined)?.code === DEADLOCK_DETECTED) return true;
  const message = (error as { message?: string } | null | undefined)?.message ?? '';
  return message.includes('deadlock detected');
}

/**
 * Reintenta UNA sola vez cuando Postgres reporta deadlock (40P01).
 *
 * No es un retry genérico: cualquier otro error sube de inmediato, sin reintentar
 * (un `insufficient_stock` reintentado sería una forma silenciosa de sobreventa
 * intermitente). Tampoco se oculta el deadlock: cada reintento se registra, para
 * que uno recurrente sea visible en los logs en vez de quedar tapado.
 *
 * Se exporta para poder probar el comportamiento sin base de datos.
 */
export async function withDeadlockRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await run();
    } catch (error) {
      if (!isDeadlockError(error) || attempt >= DEADLOCK_MAX_ATTEMPTS) throw error;

      console.warn(
        `[commerce] deadlock (40P01) en ${label}: reintento ${attempt}/${DEADLOCK_MAX_ATTEMPTS - 1}`,
      );
      await new Promise((resolve) => setTimeout(resolve, DEADLOCK_RETRY_DELAY_MS * attempt));
    }
  }
}

/**
 * Cuántos pedidos vencidos libera cada barrido.
 *
 * Un único número para el cron diario y para las expiraciones dirigidas: el reaper
 * está indexado por `idx_orders_expiring`, así que el barrido es barato cuando no hay
 * nada vencido y acotado cuando sí lo hay.
 */
const STALE_ORDER_SWEEP_LIMIT = 200;

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
    // El batch entero se reintenta UNA vez si Postgres detecta deadlock (40P01).
    // Seguro porque el deadlock revierte la transacción completa: no hay forma de
    // re-emitir un lote a medias. Cualquier otro error sube sin reintentarse.
    results = await withDeadlockRetry('createOrder', async () => {
      return (await sql.transaction([
        orderStatement,
        ...itemStatements,
        reserveStatement,
      ])) as unknown as TransactionResults;
    });
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
 * Revoca los PINs vigentes de un pedido.
 *
 * Devuelve la sentencia (no la ejecuta) para poder meterla en la MISMA transacción que
 * libera el stock y transiciona el estado: o se revoca y se libera, o no pasa nada.
 *
 * POR QUÉ ES OBLIGATORIO EN CUALQUIER CANCELACIÓN: `redeem_pickup_code()` NO mira el
 * estado del pedido, así que un pedido cancelado con el PIN todavía `issued` conserva un
 * PIN vivo. Al teclearlo, `redeem_pickup_code_verified()` llama a
 * `inventory_commit_order()` sobre una reserva ya liberada y el CHECK
 * `quantity_reserved >= 0` aborta la transacción: el kiosco ve un error interno en vez
 * de "ese PIN ya venció". Revocar antes de liberar cierra ese hueco.
 *
 * Idempotente: solo toca `status = 'issued'` y no sobrescribe un motivo ya registrado.
 */
function revokeIssuedPickupCodes(sql: NeonQuery, orderId: string, reason: string) {
  return sql`
    UPDATE pickup_codes
       SET status = 'revoked',
           revoked_at = COALESCE(revoked_at, NOW()),
           revocation_reason = COALESCE(revocation_reason, ${reason})
     WHERE order_id = ${orderId}::uuid
       AND status = 'issued'
    RETURNING id
  `;
}

/**
 * Cancela el pedido: revoca sus PINs, libera el stock retenido y transiciona, atómicamente.
 *
 * `inventory_release_order()` es un no-op si no hay reserva viva, así que se puede
 * llamar sin condiciones. Si el cambio de estado fuera inválido, el rollback también
 * revierte la revocación del PIN y la liberación de stock (nunca queda stock "liberado"
 * ni un PIN revocado en un pedido vivo).
 */
export async function cancelOrder(
  orderId: string,
  options: { reason?: string; actor?: string } = {},
): Promise<Order> {
  const sql = requireSql();
  const reason = options.reason ?? 'cancelled_by_user';

  const results = (await sql.transaction([
    sql`SELECT set_config('app.actor', ${options.actor ?? 'system'}, true)`,
    // El PIN se revoca ANTES de liberar: un canje posterior no puede llegar al commit.
    revokeIssuedPickupCodes(sql, orderId, reason),
    sql`SELECT inventory_release_order(${orderId}::uuid, ${reason}) AS released_lines`,
    sql`
      UPDATE orders
         SET status = 'cancelled'::order_status,
             cancelled_reason = ${reason}
       WHERE id = ${orderId}::uuid
      RETURNING *
    `,
  ])) as unknown as TransactionResults;

  const orderRow = rowAt<OrderRow>(results, 3);
  if (!orderRow) throw new Error(`cancelOrder: pedido ${orderId} no encontrado`);
  return toOrder(orderRow);
}

// =============================================================================
//  3.c LIMPIEZA QA DE PEDIDOS (solo Preview — ver lib/qa-order-cleanup.server.ts)
//
//  Dos operaciones, ninguna borra nada:
//    · LISTAR  → vista administrativa REDACTADA (sin token público ni PIN).
//    · CANCELAR → cerrar un pedido operativo liberando su reserva y revocando su PIN.
// =============================================================================

/** Estados que aparecen (o pueden aparecer) en la cola del kiosco. */
const DEFAULT_ADMIN_ORDER_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'preparing',
  'ready_for_pickup',
];

/** Tope defensivo del listado: es una pantalla de diagnóstico, no un export. */
const ADMIN_ORDER_LIST_MAX_LIMIT = 200;
const ADMIN_ORDER_LIST_DEFAULT_LIMIT = 50;

export interface ListAdminOrdersOptions {
  /** Estados a incluir. Por defecto, los operativos. */
  statuses?: OrderStatus[];
  limit?: number;
}

/**
 * Pedidos para el diagnóstico administrativo, con líneas y estado del PIN.
 *
 * Lee en dos pasos (cabeceras, y después líneas + códigos de ESOS pedidos) para no
 * hacer N+1 ni arrastrar `orders` a una agregación. Todo va en una transacción de
 * solo lectura para que el listado sea consistente consigo mismo.
 */
export async function listAdminOrders(
  options: ListAdminOrdersOptions = {},
): Promise<AdminOrderView[]> {
  const sql = requireSql();

  const statuses = options.statuses?.length ? options.statuses : [...DEFAULT_ADMIN_ORDER_STATUSES];
  const requestedLimit = Number(options.limit);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, ADMIN_ORDER_LIST_MAX_LIMIT)
      : ADMIN_ORDER_LIST_DEFAULT_LIMIT;

  const orderRows = (await sql`
    SELECT * FROM orders
     WHERE status = ANY(${statuses}::order_status[])
     ORDER BY created_at DESC
     LIMIT ${limit}
  `) as unknown as OrderRow[];

  if (orderRows.length === 0) return [];

  const orderIds = orderRows.map((row) => row.id);

  const results = (await sql.transaction(
    [
      sql`SELECT * FROM order_items WHERE order_id = ANY(${orderIds}::uuid[]) ORDER BY line_number`,
      sql`SELECT * FROM pickup_codes WHERE order_id = ANY(${orderIds}::uuid[]) ORDER BY created_at DESC`,
    ],
    { readOnly: true },
  )) as unknown as TransactionResults;

  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const item of rowsAt<OrderItemRow>(results, 0)) {
    const bucket = itemsByOrder.get(item.order_id) ?? [];
    bucket.push(item);
    itemsByOrder.set(item.order_id, bucket);
  }

  const codesByOrder = new Map<string, PickupCodeRow[]>();
  for (const code of rowsAt<PickupCodeRow>(results, 1)) {
    const bucket = codesByOrder.get(code.order_id) ?? [];
    bucket.push(code);
    codesByOrder.set(code.order_id, bucket);
  }

  return orderRows.map((row) =>
    toAdminOrderView(row, itemsByOrder.get(row.id) ?? [], codesByOrder.get(row.id) ?? []),
  );
}

/**
 * Fila cruda de una línea con lo que el ledger dice de ella (`SELECT oi.*` + columnas).
 * El JSON agregado ya viene en camelCase (lo arma `json_build_object`).
 */
interface ReservationItemRow extends OrderItemRow {
  is_live_reservation: boolean;
  movements: AdminInventoryMovementView[] | null;
}

export interface ListReservationHoldersOptions {
  /** Filtra por slug de producto (p. ej. `dyson-v15-detect`). Sin filtro = todos los SKUs. */
  productSlug?: string;
  limit?: number;
}

/**
 * Pedidos que RETIENEN stock AHORA, según el LEDGER (solo lectura).
 *
 * ─── POR QUÉ NO SE PUEDE USAR `listAdminOrders()` ───────────────────────────
 * Ese listado filtra por `status` (los 3 operativos del kiosco) y por eso es CIEGO a
 * las únicas reservas que importan acá: las que quedaron en estados que el kiosco no
 * muestra (`pending_payment`, `expired`, `cancelled`, `picked_up`…).
 *
 * ─── CUÁL ES LA AUTORIDAD ───────────────────────────────────────────────────
 * `inventory_movements`, no `orders.status`. Una línea retiene stock si el ÚLTIMO
 * movimiento de su ciclo (`reservation`/`reservation_release`/`sale`) es `reservation`.
 * Es la MISMA definición que usa `inventory_rereserve_order()`.
 *
 * ⚠️ NO alcanza con "existe `reservation` y nunca hubo `release`/`sale`": una línea
 * liberada (p. ej. por el reaper) y RE-RESERVADA por un pago tardío vuelve a retener
 * stock aunque tenga un `reservation_release` anterior. Ese predicado más débil (el que
 * usa hoy `inventory_release_order()`) es justamente el que deja reservas varadas.
 *
 * No es un export libre: misma lista blanca que el listado (`AdminOrderView`), sin
 * `public_token`, PIN, `payment_reference`, `idempotency_key` ni `metadata` cruda.
 */
export async function listOrdersWithActiveReservations(
  options: ListReservationHoldersOptions = {},
): Promise<AdminReservationHolderView[]> {
  const sql = requireSql();

  const productSlug = options.productSlug?.trim() ? options.productSlug.trim() : null;
  const requestedLimit = Number(options.limit);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, ADMIN_ORDER_LIST_MAX_LIMIT)
      : ADMIN_ORDER_LIST_DEFAULT_LIMIT;

  // `reservation_released = FALSE` es redundante con el predicado del ledger (una
  // reserva viva implica que no se liberó), pero se deja explícito: es la condición
  // que pidió la auditoría y hace la intención legible en la consulta.
  const orderRows = (await sql`
    SELECT * FROM orders o
     WHERE o.reservation_released = FALSE
       AND EXISTS (
       SELECT 1
         FROM order_items oi
        WHERE oi.order_id = o.id
          AND (${productSlug}::text IS NULL OR oi.product_slug = ${productSlug})
          AND (
                SELECT m.movement_type
                  FROM inventory_movements m
                 WHERE m.order_item_id = oi.id
                   AND m.movement_type IN ('reservation', 'reservation_release', 'sale')
                 ORDER BY m.created_at DESC, m.id DESC
                 LIMIT 1
              ) = 'reservation'
     )
     ORDER BY created_at DESC
     LIMIT ${limit}
  `) as unknown as OrderRow[];

  if (orderRows.length === 0) return [];

  const orderIds = orderRows.map((row) => row.id);

  const results = (await sql.transaction(
    [
      sql`
        SELECT oi.*,
               (
                 SELECT m.movement_type
                   FROM inventory_movements m
                  WHERE m.order_item_id = oi.id
                    AND m.movement_type IN ('reservation', 'reservation_release', 'sale')
                  ORDER BY m.created_at DESC, m.id DESC
                  LIMIT 1
               ) = 'reservation' AS is_live_reservation,
               COALESCE((
                 SELECT json_agg(json_build_object(
                          'id', m.id::text,
                          'movementType', m.movement_type,
                          'onHandDelta', m.on_hand_delta,
                          'reservedDelta', m.reserved_delta,
                          'onHandAfter', m.on_hand_after,
                          'reservedAfter', m.reserved_after,
                          'reason', m.reason,
                          'performedBy', m.performed_by,
                          'createdAt', m.created_at)
                        ORDER BY m.created_at DESC)
                   FROM inventory_movements m
                  WHERE m.order_item_id = oi.id), '[]'::json) AS movements
          FROM order_items oi
         WHERE oi.order_id = ANY(${orderIds}::uuid[])
         ORDER BY oi.order_id, oi.line_number
      `,
      sql`SELECT * FROM pickup_codes WHERE order_id = ANY(${orderIds}::uuid[]) ORDER BY created_at DESC`,
    ],
    { readOnly: true },
  )) as unknown as TransactionResults;

  const linesByOrder = new Map<string, AdminReservationLineInput[]>();
  for (const row of rowsAt<ReservationItemRow>(results, 0)) {
    const bucket = linesByOrder.get(row.order_id) ?? [];
    bucket.push({
      item: row,
      isLiveReservation: Boolean(row.is_live_reservation),
      movements: Array.isArray(row.movements) ? row.movements : [],
    });
    linesByOrder.set(row.order_id, bucket);
  }

  const codesByOrder = new Map<string, PickupCodeRow[]>();
  for (const code of rowsAt<PickupCodeRow>(results, 1)) {
    const bucket = codesByOrder.get(code.order_id) ?? [];
    bucket.push(code);
    codesByOrder.set(code.order_id, bucket);
  }

  return orderRows.map((row) =>
    toAdminReservationHolderView(
      row,
      linesByOrder.get(row.id) ?? [],
      codesByOrder.get(row.id) ?? [],
    ),
  );
}

// =============================================================================
//  3.d AUDITORÍA DEL LEDGER DE INVENTARIO (solo lectura)
//
//  Existe para reconciliar `inventory.quantity_reserved` contra `inventory_movements`
//  cuando ambos no cuadran. NO escribe nada.
// =============================================================================

/** Tope defensivo: la auditoría es diagnóstica, no un export del ledger completo. */
const INVENTORY_MOVEMENTS_MAX_LIMIT = 2000;
const INVENTORY_MOVEMENTS_DEFAULT_LIMIT = 500;

export interface ListInventoryMovementsOptions {
  /** Slug del producto a auditar (obligatorio). */
  productSlug: string;
  /** `variant_key` opcional; sin él se auditan TODAS las variantes del producto. */
  variantKey?: string;
  locationCode?: string;
  limit?: number;
}

export interface InventoryAuditRowView {
  variantKey: string;
  onHand: number;
  reserved: number;
  available: number;
  updatedAt: string;
}

export interface InventoryOrderAuditView {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  reservationReleased: boolean;
  createdAt: string;
}

export interface InventoryMovementsAudit {
  productSlug: string;
  variantKey: string | null;
  locationCode: string;
  /** `true` si el tope de movimientos pudo truncar la lectura (reconciliación incompleta). */
  truncated: boolean;
  inventory: InventoryAuditRowView[];
  reconciliations: ReservedReconciliation[];
  lines: ReservationLineAudit[];
  /** Movimientos sin `order_item_id`: no atribuibles a ninguna línea. */
  unattributed: { count: number; reservedDeltaSum: number };
  movements: InventoryMovementAudit[];
  orders: InventoryOrderAuditView[];
}

/**
 * Ledger del SKU (todos sus movimientos) + reconciliación de `reserved`, en solo lectura.
 *
 * Devuelve TODO lo que hace falta para decidir A/B/C/D/E de una reserva huérfana:
 * la secuencia de movimientos, si el último del ciclo es `reservation`, y el primer
 * punto donde la suma corrida diverge de `inventory.quantity_reserved`.
 */
export async function listInventoryMovements(
  options: ListInventoryMovementsOptions,
): Promise<InventoryMovementsAudit> {
  const sql = requireSql();

  const productSlug = options.productSlug.trim();
  const variantKey = options.variantKey?.trim() ? options.variantKey.trim() : null;
  const locationCode = options.locationCode?.trim() || 'MAIN';
  const requestedLimit = Number(options.limit);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, INVENTORY_MOVEMENTS_MAX_LIMIT)
      : INVENTORY_MOVEMENTS_DEFAULT_LIMIT;

  const inventoryRows = (await sql`
    SELECT * FROM inventory
     WHERE product_slug = ${productSlug}
       AND location_code = ${locationCode}
       AND (${variantKey}::text IS NULL OR variant_key = ${variantKey})
     ORDER BY variant_key
  `) as unknown as InventoryRow[];

  const movementRows = (await sql`
    SELECT m.id::text AS id, m.order_id, m.order_item_id, m.movement_type,
           m.on_hand_delta, m.reserved_delta, m.on_hand_after, m.reserved_after,
           m.idempotency_key, m.reason, m.performed_by, m.created_at,
           i.variant_key
      FROM inventory_movements m
      JOIN inventory i ON i.id = m.inventory_id
     WHERE i.product_slug = ${productSlug}
       AND i.location_code = ${locationCode}
       AND (${variantKey}::text IS NULL OR i.variant_key = ${variantKey})
     ORDER BY m.created_at, m.id
     LIMIT ${limit + 1}
  `) as unknown as Array<{
    id: string;
    order_id: string | null;
    order_item_id: string | null;
    movement_type: string;
    on_hand_delta: number;
    reserved_delta: number;
    on_hand_after: number;
    reserved_after: number;
    idempotency_key: string | null;
    reason: string | null;
    performed_by: string | null;
    created_at: string;
    variant_key: string;
  }>;

  // Leemos uno de más para saber si el tope truncó (y no mentir en la reconciliación).
  const truncated = movementRows.length > limit;
  const movements: InventoryMovementAudit[] = movementRows.slice(0, limit).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    movementType: row.movement_type,
    onHandDelta: Number(row.on_hand_delta),
    reservedDelta: Number(row.reserved_delta),
    onHandAfter: Number(row.on_hand_after),
    reservedAfter: Number(row.reserved_after),
    idempotencyKey: row.idempotency_key,
    reason: row.reason,
    performedBy: row.performed_by,
    createdAt: row.created_at,
    variantKey: row.variant_key,
  }));

  const reconciliations = inventoryRows.map((row) =>
    reconcileReservedDeltas(
      movements.filter((movement) => movement.variantKey === row.variant_key),
      Number(row.quantity_reserved),
      row.variant_key,
    ),
  );

  const { lines, unattributed } = classifyReservationLines(movements);
  const unattributedReservedSum = unattributed.reduce((sum, m) => sum + m.reservedDelta, 0);

  const orderIds = [
    ...new Set(movements.map((m) => m.orderId).filter((id): id is string => Boolean(id))),
  ];

  const orderRows =
    orderIds.length > 0
      ? ((await sql`
          SELECT id, order_number, status, payment_status, reservation_released, created_at
            FROM orders
           WHERE id = ANY(${orderIds}::uuid[])
        `) as unknown as Array<{
          id: string;
          order_number: string;
          status: OrderStatus;
          payment_status: PaymentStatus;
          reservation_released: boolean;
          created_at: string;
        }>)
      : [];

  return {
    productSlug,
    variantKey,
    locationCode,
    truncated,
    inventory: inventoryRows.map((row) => ({
      variantKey: row.variant_key,
      onHand: Number(row.quantity_on_hand),
      reserved: Number(row.quantity_reserved),
      available: Number(row.quantity_available),
      updatedAt: row.updated_at,
    })),
    reconciliations,
    lines,
    unattributed: { count: unattributed.length, reservedDeltaSum: unattributedReservedSum },
    movements,
    orders: orderRows.map((row) => ({
      orderId: row.id,
      orderNumber: row.order_number,
      status: row.status,
      paymentStatus: row.payment_status,
      reservationReleased: row.reservation_released,
      createdAt: row.created_at,
    })),
  };
}

export interface QaOrderCancelResult {
  orderNumber: string;
  previousStatus: OrderStatus;
  status: OrderStatus;
  /** Líneas cuya reserva se soltó AHORA (0 en un no-op idempotente). */
  releasedLines: number;
  /** PINs vigentes revocados AHORA (0 si ya estaban revocados). */
  revokedCodes: number;
  alreadyCancelled: boolean;
}

/**
 * Cierra un pedido QA: revoca su PIN, libera su reserva y lo pasa a `cancelled`.
 *
 * ─── POR QUÉ ES UNA FUNCIÓN PROPIA ───────────────────────────────────────────
 * Hace exactamente lo mismo que `cancelOrder()` (revocar PINs → liberar stock →
 * transicionar, todo en una transacción) pero REPORTA los conteos
 * (`releasedLines` / `revokedCodes`) y el estado previo, que es lo que necesita una
 * limpieza por lote para demostrar qué hizo en cada pedido. `cancelOrder()` devuelve
 * solo el pedido, así que no alcanza para auditar el lote.
 *
 * El hueco de `pickup_codes` está cerrado en LAS DOS: `cancelOrder()` también revoca.
 *
 * ─── ATOMICIDAD E IDEMPOTENCIA ──────────────────────────────────────────────
 * Las cuatro sentencias van en UNA transacción: si la transición no es válida, el
 * trigger la rechaza y el rollback deshace TAMBIÉN la revocación del PIN y la
 * liberación de stock (nunca queda medio limpiado).
 *
 * La segunda corrida es un no-op limpio:
 *   · la revocación solo toca `status = 'issued'` (ya no hay ninguna),
 *   · `inventory_release_order()` tiene guardas + clave de idempotencia
 *     (`release:<orderId>:<itemId>`), así que no duplica movimientos,
 *   · el UPDATE de estado no cambia nada si ya estaba `cancelled` (el trigger no
 *     escribe historial ni sube la versión),
 *   · `cancelled_reason` no se sobrescribe si ya tenía un motivo.
 *
 * El estado se lee ANTES de la transacción solo para reportar `previousStatus` y el
 * no-op idempotente. Si el estado cambiara en el medio, la autoridad sigue siendo el
 * trigger: la transición inválida revierte todo.
 */
export async function cancelOrderForQa(
  orderId: string,
  reason = 'qa_cleanup',
): Promise<QaOrderCancelResult> {
  const sql = requireSql();

  const before = (await sql`
    SELECT status FROM orders WHERE id = ${orderId}::uuid LIMIT 1
  `) as unknown as Array<{ status: OrderStatus }>;

  const previousStatus = before[0]?.status;
  if (!previousStatus) {
    throw new Error(`cancelOrderForQa: pedido ${orderId} no encontrado`);
  }

  const results = (await sql.transaction([
    sql`SELECT set_config('app.actor', 'qa:order-cleanup', true)`,
    // 1) Revocar PINs vigentes. Antes de liberar stock: si la transición falla, el
    //    rollback deshace esto también.
    revokeIssuedPickupCodes(sql, orderId, reason),
    // 2) Soltar la reserva por el motor del ledger (no-op si ya se soltó o se vendió).
    sql`SELECT inventory_release_order(${orderId}::uuid, ${reason}) AS released_lines`,
    // 3) Transición válida; el trigger sella `cancelled_at`, sube `version` y escribe
    //    `order_status_history` con `app.actor`.
    sql`
      UPDATE orders
         SET status = 'cancelled'::order_status,
             cancelled_reason = COALESCE(cancelled_reason, ${reason})
       WHERE id = ${orderId}::uuid
      RETURNING *
    `,
  ])) as unknown as TransactionResults;

  const revokedCodes = rowsAt<{ id: string }>(results, 1).length;
  const releasedLines = Number(
    rowAt<{ released_lines: number }>(results, 2)?.released_lines ?? 0,
  );

  const orderRow = rowAt<OrderRow>(results, 3);
  if (!orderRow) throw new Error(`cancelOrderForQa: pedido ${orderId} no encontrado`);

  return {
    orderNumber: orderRow.order_number,
    previousStatus,
    status: orderRow.status,
    releasedLines,
    revokedCodes,
    alreadyCancelled: previousStatus === 'cancelled',
  };
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
 * Disponibilidad de stock por variante, para el catálogo público.
 *
 * Es de SOLO LECTURA: el catálogo la usa para mostrar disponibilidad real y para
 * deshabilitar combinaciones agotadas, nunca para decidir una venta. La autoridad
 * sigue siendo `inventory` leído a través de `inventory_apply_movement()`.
 *
 * ─── POR QUÉ NO SE DEVUELVE `quantity_available` TAL CUAL ───────────────────
 * `quantity_reserved` incluye las reservas VENCIDAS que el reaper todavía no liberó
 * (con el cron diario puede tardar hasta un día). Contarlas mostraría "agotado" un
 * producto que en realidad está libre. Se descuentan SOLO en esta lectura: sin tocar
 * el esquema y sin convertir un GET público de alto tráfico en una escritura.
 *
 * El predicado de "retención fantasma" es el del propio reaper
 * (`expire_stale_orders`): pedido `pending_payment`, reserva no liberada y vencimiento
 * ya pasado. NO se consulta `inventory_movements` a propósito: para un pedido en
 * `pending_payment` el flag `reservation_released` es fiel —la creación del pedido es
 * atómica con la reserva, y sólo se libera marcando ese flag—, así que la consulta se
 * apoya en `idx_orders_expiring` en vez de recorrer el ledger.
 *
 * Presupuesto de local: los pedidos reservan en el mismo local que se consulta
 * (`MAIN` por defecto). Si algún día hay pedidos en varios locales, esta resta tiene
 * que pasar por `inventory_movements.inventory_id` para atribuir cada retención a su local.
 */
export interface VariantAvailability {
  productSlug: string;
  variantKey: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
}

export async function getVariantAvailability(
  slugs: string[],
  locationCode = 'MAIN',
): Promise<VariantAvailability[]> {
  if (slugs.length === 0) return [];
  const sql = requireSql();

  // `quantity_reserved` se recalcula (reservado real − retenciones vencidas) y
  // `quantity_available` se deriva de ahí, con tope en cero: nunca negativo.
  const rows = (await sql`
    WITH stale_holds AS (
      SELECT oi.product_slug AS product_slug,
             oi.variant_key  AS variant_key,
             SUM(oi.quantity)::INTEGER AS held
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'pending_payment'
         AND o.reservation_released = FALSE
         AND o.reservation_expires_at IS NOT NULL
         AND o.reservation_expires_at < NOW()
       GROUP BY oi.product_slug, oi.variant_key
    )
    SELECT i.product_slug,
           i.variant_key,
           i.quantity_on_hand,
           GREATEST(i.quantity_reserved - COALESCE(sh.held, 0), 0) AS quantity_reserved,
           i.quantity_on_hand
             - GREATEST(i.quantity_reserved - COALESCE(sh.held, 0), 0) AS quantity_available
      FROM inventory i
      LEFT JOIN stale_holds sh
        ON sh.product_slug = i.product_slug
       AND sh.variant_key  = i.variant_key
     WHERE i.location_code = ${locationCode}
       AND i.product_slug = ANY(${slugs}::text[])
       AND i.is_active = TRUE
  `) as unknown as Array<{
    product_slug: string;
    variant_key: string;
    quantity_on_hand: number;
    quantity_reserved: number;
    quantity_available: number;
  }>;

  return rows.map((row) => ({
    productSlug: row.product_slug,
    variantKey: row.variant_key,
    quantityOnHand: Number(row.quantity_on_hand),
    quantityReserved: Number(row.quantity_reserved),
    quantityAvailable: Number(row.quantity_available),
  }));
}

/**
 * Inventario completo del local (solo lectura). Lo usa el panel de operación.
 * Ordenado por disponibilidad ascendente: lo que está por agotarse queda arriba.
 */
export async function listInventory(locationCode = 'MAIN', limit = 500): Promise<InventoryItem[]> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT * FROM inventory
     WHERE location_code = ${locationCode}
     ORDER BY quantity_available ASC, product_slug, variant_key
     LIMIT ${limit}
  `) as unknown as InventoryRow[];
  return rows.map(toInventoryItem);
}

/**
 * SKUs en o por debajo de su punto de reorden (`reorder_point > 0`).
 * Es la base de las alertas de stock bajo que revisa la tienda.
 */
export async function listLowStock(locationCode = 'MAIN'): Promise<InventoryItem[]> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT * FROM inventory
     WHERE location_code = ${locationCode}
       AND is_active = TRUE
       AND reorder_point > 0
       AND quantity_available <= reorder_point
     ORDER BY (quantity_available - reorder_point) ASC, product_slug, variant_key
  `) as unknown as InventoryRow[];
  return rows.map(toInventoryItem);
}

/**
 * Ajusta el punto de reorden de un SKU. NO toca cantidades (no es un movimiento de
 * stock); solo configura el umbral de alerta. Crea la fila del SKU en cero si aún no
 * existe, para poder vigilar un producto antes de recibir mercadería.
 */
export async function setReorderPoint(
  productSlug: string,
  variantKey: string,
  reorderPoint: number,
  locationCode = 'MAIN',
): Promise<InventoryItem | null> {
  const sql = requireSql();
  const rows = (await sql`
    INSERT INTO inventory (location_code, product_slug, variant_key, reorder_point)
    VALUES (${locationCode}, ${productSlug}, ${variantKey}, ${reorderPoint})
    ON CONFLICT (location_code, product_slug, variant_key)
    DO UPDATE SET reorder_point = EXCLUDED.reorder_point
    RETURNING *
  `) as unknown as InventoryRow[];
  return rows[0] ? toInventoryItem(rows[0]) : null;
}

/** SKUs (slug + variante) de las líneas de un pedido. Para revisar stock tras una venta. */
export async function getOrderItemSkus(
  orderId: string,
): Promise<Array<{ productSlug: string; variantKey: string; productName: string; quantity: number }>> {
  const sql = requireSql();
  const rows = (await sql`
    SELECT product_slug, variant_key, product_name, quantity
      FROM order_items
     WHERE order_id = ${orderId}::uuid
     ORDER BY line_number
  `) as unknown as Array<{
    product_slug: string;
    variant_key: string;
    product_name: string;
    quantity: number;
  }>;

  return rows.map((row) => ({
    productSlug: row.product_slug,
    variantKey: row.variant_key,
    productName: row.product_name,
    quantity: Number(row.quantity),
  }));
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
 * Reaper de reservas vencidas — el ÚNICO motor que libera stock fuera de una venta.
 *
 * Libera el stock de los pedidos `pending_payment` sin pagar y los marca `expired`.
 * "Vencida" lo decide Postgres (`reservation_expires_at < NOW()`), con el MISMO reloj
 * con el que se escribió el vencimiento: es imposible liberar una reserva válida antes
 * de tiempo por desfase de reloj de Node.
 *
 * Se llama desde tres lugares, siempre por este mismo camino:
 *   1. el cron diario de Vercel (`/api/cron/expire-reservations`), como backstop;
 *   2. la expiración perezosa de `POST /api/orders`, ANTES de reservar, para no
 *      rechazar una venta por stock que en realidad ya está libre;
 *   3. la expiración dirigida de `/api/payments/preference` y de la página del pedido,
 *      para que el estado que ve el comprador sea el real y el stock se suelte ya.
 *
 * Es idempotente y acotado; reintenta una vez si Postgres reporta deadlock (40P01).
 */
export async function expireStaleOrders(limit = STALE_ORDER_SWEEP_LIMIT): Promise<number> {
  const sql = requireSql();
  const rows = await withDeadlockRetry('expireStaleOrders', async () => {
    return (await sql`
      SELECT expire_stale_orders(${limit}) AS expired_orders
    `) as unknown as Array<{ expired_orders: number }>;
  });
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
               (SELECT string_agg(
                         oi.product_name
                         || COALESCE(' [' || (SELECT string_agg(e.value, '·' ORDER BY e.key)
                                                FROM jsonb_each_text(oi.variant) e) || ']', '')
                         || ' ×' || oi.quantity,
                         ' · ' ORDER BY oi.line_number)
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
               (SELECT string_agg(
                         oi.product_name
                         || COALESCE(' [' || (SELECT string_agg(e.value, '·' ORDER BY e.key)
                                                FROM jsonb_each_text(oi.variant) e) || ']', '')
                         || ' ×' || oi.quantity,
                         ' · ' ORDER BY oi.line_number)
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

/**
 * Código de retiro VIGENTE de un pedido, para mostrárselo al cliente.
 *
 * ⚠️ `expires_at > NOW()` no es decorativo: el vencimiento de un PIN es PEREZOSO.
 * `redeem_pickup_code()` marca `status = 'expired'` sólo cuando alguien intenta
 * canjearlo, así que un PIN vencido sigue en `'issued'` durante días. Sin este filtro
 * la pantalla del cliente le mostraría un código que el kiosco va a rechazar con
 * "Ese PIN ya venció" — con el cliente parado en el mostrador.
 *
 * Devuelve `null` cuando no hay ningún código vivo (pedido sin preparar, PIN vencido
 * o ya canjeado): la pantalla simplemente no muestra el bloque de retiro.
 */
export async function getIssuedPickupCode(orderId: string): Promise<PickupCode | null> {
  const sql = requireSql();

  const rows = (await sql`
    SELECT * FROM pickup_codes
     WHERE order_id = ${orderId}::uuid
       AND status = 'issued'
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1
  `) as unknown as PickupCodeRow[];

  return rows[0] ? toPickupCode(rows[0]) : null;
}

// =============================================================================
//  6. OBSERVABILIDAD DEL WEBHOOK DE PAGO (diagnóstico, best-effort)
//
//  Ver `lib/payment-webhook-observability.ts` (qué se deriva) y la migración 004
//  (dónde se guarda). Acá solo vive el acceso a datos.
//
//  REGLA: la escritura es BEST-EFFORT. Un fallo al registrar NO puede tumbar una
//  notificación legítima, ni cambiar el 401/200 que decide la ruta. Si la tabla
//  todavía no existe (migración sin aplicar), el webhook sigue igual.
// =============================================================================

export interface PaymentWebhookEventInput {
  /** ISO 8601 del momento en que la ruta recibió el request. */
  receivedAt: string;
  /** Campos NO sensibles derivados por `buildWebhookEventRecord()`. */
  record: PaymentWebhookEventRecord;
  /** true/false según la validación; null si no se llegó a evaluar (p. ej. 503). */
  signatureOk: boolean | null;
  /** Etiqueta corta del resultado. */
  result: string | null;
  /** Código HTTP que la ruta devolvió (o se propuso devolver). */
  httpStatus: number | null;
}

/** Fila de `payment_webhook_events` ya normalizada a camelCase para la API. */
export interface PaymentWebhookEvent extends PaymentWebhookEventRecord {
  id: string;
  receivedAt: string;
  signatureOk: boolean | null;
  result: string | null;
  httpStatus: number | null;
}

interface PaymentWebhookEventRow {
  id: string;
  received_at: string;
  pathname: string | null;
  query_param_names: unknown;
  data_id: string | null;
  query_data_id_present: boolean;
  query_data_id_length: number | null;
  query_data_id_matches_body: boolean | null;
  query_type: string | null;
  body_type: string | null;
  action: string | null;
  live_mode: boolean | null;
  body_user_id: string | null;
  x_request_id_present: boolean;
  x_request_id_length: number | null;
  x_signature_present: boolean;
  signature_has_ts: boolean;
  signature_has_v1: boolean;
  ts_length: number | null;
  v1_length: number | null;
  user_agent: string | null;
  x_retry: string | null;
  signature_ok: boolean | null;
  result: string | null;
  http_status: number | null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function toPaymentWebhookEvent(row: PaymentWebhookEventRow): PaymentWebhookEvent {
  return {
    id: row.id,
    receivedAt: row.received_at,
    pathname: row.pathname ?? '',
    queryParamNames: toStringArray(row.query_param_names),
    dataId: row.data_id,
    queryDataIdPresent: row.query_data_id_present,
    queryDataIdLength: row.query_data_id_length,
    queryDataIdMatchesBody: row.query_data_id_matches_body,
    queryType: row.query_type,
    bodyType: row.body_type,
    action: row.action,
    liveMode: row.live_mode,
    bodyUserId: row.body_user_id,
    xRequestIdPresent: row.x_request_id_present,
    xRequestIdLength: row.x_request_id_length,
    xSignaturePresent: row.x_signature_present,
    signatureHasTs: row.signature_has_ts,
    signatureHasV1: row.signature_has_v1,
    tsLength: row.ts_length,
    v1Length: row.v1_length,
    userAgent: row.user_agent,
    xRetry: row.x_retry,
    signatureOk: row.signature_ok,
    result: row.result,
    httpStatus: row.http_status,
  };
}

/**
 * Persiste un evento de webhook. NUNCA lanza.
 *
 * `options.sql` permite inyectar un cliente (tests): pasar `null` desactiva la
 * persistencia; omitirlo usa el cliente real. Cualquier fallo —base sin configurar,
 * tabla ausente, red caída— se registra en logs y la función resuelve igual. Esa es
 * la garantía de que la observabilidad no cambia el comportamiento del webhook.
 */
export async function recordPaymentWebhookEvent(
  input: PaymentWebhookEventInput,
  options: { sql?: NeonQuery | null } = {},
): Promise<void> {
  if (options.sql === null) return;

  let sql: NeonQuery | null;
  try {
    sql = options.sql ?? getCommerceSql();
  } catch (error) {
    console.warn('[commerce] no se pudo resolver el cliente para observabilidad de webhooks', error);
    return;
  }
  if (!sql) return;

  const r = input.record;
  try {
    await sql`
      INSERT INTO payment_webhook_events (
        received_at, pathname, query_param_names,
        data_id, query_data_id_present, query_data_id_length, query_data_id_matches_body,
        query_type, body_type, action, live_mode, body_user_id,
        x_request_id_present, x_request_id_length,
        x_signature_present, signature_has_ts, signature_has_v1, ts_length, v1_length,
        user_agent, x_retry, signature_ok, result, http_status
      ) VALUES (
        ${input.receivedAt}::timestamptz,
        ${r.pathname},
        ${JSON.stringify(r.queryParamNames)}::jsonb,
        ${r.dataId},
        ${r.queryDataIdPresent},
        ${r.queryDataIdLength},
        ${r.queryDataIdMatchesBody},
        ${r.queryType},
        ${r.bodyType},
        ${r.action},
        ${r.liveMode},
        ${r.bodyUserId},
        ${r.xRequestIdPresent},
        ${r.xRequestIdLength},
        ${r.xSignaturePresent},
        ${r.signatureHasTs},
        ${r.signatureHasV1},
        ${r.tsLength},
        ${r.v1Length},
        ${r.userAgent},
        ${r.xRetry},
        ${input.signatureOk},
        ${input.result},
        ${input.httpStatus}
      )
    `;
  } catch (error) {
    // BEST-EFFORT: se registra el fallo y se sigue. Nunca se propaga.
    console.warn('[commerce] no se pudo registrar el evento del webhook de pago', error);
  }
}

/**
 * Últimos eventos de webhook, más reciente primero. Solo lectura.
 *
 * `dataId` filtra por recurso (p. ej. el Payment ID del pago investigado). El límite
 * se acota en la capa de datos ([1, 200]) para que ningún consumidor pueda pedir la
 * tabla entera.
 */
export async function listPaymentWebhookEvents(
  filter: { limit?: number; dataId?: string | null } = {},
): Promise<PaymentWebhookEvent[]> {
  const sql = requireSql();
  const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), 200);
  const dataId = filter.dataId?.trim() || null;

  const rows = (await sql`
    SELECT * FROM payment_webhook_events
     WHERE (${dataId}::text IS NULL OR data_id = ${dataId})
     ORDER BY received_at DESC, id DESC
     LIMIT ${limit}
  `) as unknown as PaymentWebhookEventRow[];

  return rows.map(toPaymentWebhookEvent);
}
