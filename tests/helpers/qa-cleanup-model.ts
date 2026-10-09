/**
 * tests/helpers/qa-cleanup-model.ts — MODELOS DE REFERENCIA (solo para tests).
 *
 * ⚠️ LIMITACIÓN IMPORTANTE
 * La verdad vive en PL/pgSQL: `inventory_apply_movement()`, `inventory_release_order()`,
 * `inventory_commit_order()`, `redeem_pickup_code()` (migración 001) y
 * `redeem_pickup_code_verified()` (003). El proyecto NO tiene Postgres en
 * `node --test`, así que esas funciones no se pueden invocar.
 *
 * Estos modelos espejan su SEMÁNTICA —incluidas las guardas y los CHECK de la tabla—
 * para pinchar la limpieza QA contra cambios accidentales: que cancelar NO descuente
 * `on_hand`, que liberar baje `reserved`, que un segundo intento no duplique movimientos
 * y que un PIN revocado no llegue nunca a comprometer stock.
 *
 * La autoridad es SIEMPRE el SQL; esto es la red de seguridad del contrato.
 */

// =============================================================================
//  Inventario
// =============================================================================

export interface Movement {
  movementType: string;
  onHandDelta: number;
  reservedDelta: number;
  orderId: string | null;
  orderItemId: string | null;
  idempotencyKey: string | null;
  reason: string | null;
}

export interface InventoryState {
  onHand: number;
  reserved: number;
  movements: Movement[];
}

export interface OrderLine {
  orderItemId: string;
  quantity: number;
}

export type ApplyMovementResult =
  | { ok: true; movement: Movement; deduped: boolean }
  | { ok: false; code: 'invalid_delta' | 'insufficient_stock' | 'constraint_violation' };

export function newInventory(onHand: number, reserved: number): InventoryState {
  return { onHand, reserved, movements: [] };
}

/** `quantity_available` es una columna generada: siempre `on_hand - reserved`. */
export function available(state: InventoryState): number {
  return state.onHand - state.reserved;
}

/**
 * Espeja `inventory_apply_movement()`:
 *   1. exige al menos un delta distinto de cero;
 *   2. idempotencia por `idempotency_key` (devuelve el movimiento existente);
 *   3. guarda anti-sobreventa del `WHERE` (`on_hand - reserved >= 0` tras el cambio);
 *   4. CHECKs de la tabla (`reserved >= 0`, `reserved <= on_hand`).
 */
export function applyMovement(
  state: InventoryState,
  input: {
    movementType: string;
    onHandDelta?: number;
    reservedDelta?: number;
    orderId?: string | null;
    orderItemId?: string | null;
    idempotencyKey?: string | null;
    reason?: string | null;
  },
): ApplyMovementResult {
  const onHandDelta = input.onHandDelta ?? 0;
  const reservedDelta = input.reservedDelta ?? 0;

  if (onHandDelta === 0 && reservedDelta === 0) return { ok: false, code: 'invalid_delta' };

  if (input.idempotencyKey) {
    const existing = state.movements.find((m) => m.idempotencyKey === input.idempotencyKey);
    if (existing) return { ok: true, movement: existing, deduped: true };
  }

  const nextOnHand = state.onHand + onHandDelta;
  const nextReserved = state.reserved + reservedDelta;

  // Guarda del WHERE (capa 2 anti-sobreventa).
  if (!(nextOnHand >= 0 && nextOnHand - nextReserved >= 0)) {
    return { ok: false, code: 'insufficient_stock' };
  }

  // CHECKs de la tabla `inventory` y de `inventory_movements`.
  if (!(nextReserved >= 0 && nextReserved <= nextOnHand)) {
    return { ok: false, code: 'constraint_violation' };
  }

  const movement: Movement = {
    movementType: input.movementType,
    onHandDelta,
    reservedDelta,
    orderId: input.orderId ?? null,
    orderItemId: input.orderItemId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    reason: input.reason ?? null,
  };

  state.onHand = nextOnHand;
  state.reserved = nextReserved;
  state.movements.push(movement);

  return { ok: true, movement, deduped: false };
}

/** ¿Esta línea tiene reserva viva? (mismo predicado que usa `inventory_release_order`). */
export function hasLiveReservation(state: InventoryState, orderItemId: string): boolean {
  const reserved = state.movements.some(
    (m) => m.orderItemId === orderItemId && m.movementType === 'reservation',
  );
  const settled = state.movements.some(
    (m) =>
      m.orderItemId === orderItemId &&
      (m.movementType === 'reservation_release' || m.movementType === 'sale'),
  );
  return reserved && !settled;
}

/**
 * Espeja `inventory_release_order()`: suelta `reserved` de las líneas con reserva viva,
 * con clave de idempotencia `release:<orderId>:<itemId>`. NO toca `on_hand`.
 */
export function releaseOrder(
  state: InventoryState,
  orderId: string,
  lines: OrderLine[],
  reason = 'qa_cleanup',
): { releasedLines: number } {
  let releasedLines = 0;

  for (const line of lines) {
    // Mismo predicado que el `WHERE` del SQL: reserva viva y sin liquidar.
    if (!hasLiveReservation(state, line.orderItemId)) continue;

    applyMovement(state, {
      movementType: 'reservation_release',
      reservedDelta: -line.quantity,
      orderId,
      orderItemId: line.orderItemId,
      idempotencyKey: `release:${orderId}:${line.orderItemId}`,
      reason,
    });
    releasedLines += 1;
  }

  return { releasedLines };
}

/**
 * Espeja `inventory_commit_order()`: convierte la reserva en venta
 * (`on_hand -= qty`, `reserved -= qty`). Lanza si la reserva ya no estaba — es
 * exactamente el fallo que hay que evitar revocando el PIN al cancelar.
 */
export function commitOrder(
  state: InventoryState,
  orderId: string,
  lines: OrderLine[],
  reason = 'picked_up',
): { committedLines: number } {
  let committedLines = 0;

  for (const line of lines) {
    const hasReservation = state.movements.some(
      (m) => m.orderItemId === line.orderItemId && m.movementType === 'reservation',
    );
    if (!hasReservation) continue;
    if (state.movements.some((m) => m.orderItemId === line.orderItemId && m.movementType === 'sale')) {
      continue;
    }

    const applied = applyMovement(state, {
      movementType: 'sale',
      onHandDelta: -line.quantity,
      reservedDelta: -line.quantity,
      orderId,
      orderItemId: line.orderItemId,
      idempotencyKey: `sale:${orderId}:${line.orderItemId}`,
      reason,
    });

    if (!applied.ok) throw new Error('insufficient_stock');
    committedLines += 1;
  }

  return { committedLines };
}

// =============================================================================
//  Canje del PIN
// =============================================================================

export interface PickupCodeState {
  code: string;
  orderId: string;
  status: 'issued' | 'redeemed' | 'expired' | 'revoked';
  attempts: number;
  maxAttempts: number;
  expiresAt: number;
}

export type RedeemModelResult = {
  ok: boolean;
  error_code: 'pickup_code_not_found' | 'pickup_code_expired' | 'pickup_code_locked' | 'pickup_code_already_used' | null;
  committed_lines: number;
  /** true si la transacción se abortó por un fallo del commit de inventario. */
  aborted: boolean;
};

/**
 * Espeja `redeem_pickup_code()` + `redeem_pickup_code_verified()`: primero los controles
 * del CÓDIGO (no del pedido), y sólo si pasan, `inventory_commit_order()`.
 *
 * Todo o nada: si el commit falla, se revierte el canje (el modelo trabaja sobre una
 * copia y solo publica el resultado si todo salió bien).
 */
export function redeemPickupCodeModel(
  code: string,
  pickups: PickupCodeState[],
  inventory: InventoryState,
  orderId: string,
  lines: OrderLine[],
  now = Date.now(),
): RedeemModelResult {
  const row = pickups.find((pickup) => pickup.code === code);
  if (!row) {
    return { ok: false, error_code: 'pickup_code_not_found', committed_lines: 0, aborted: false };
  }

  if (row.status === 'redeemed') {
    row.attempts += 1;
    return { ok: false, error_code: 'pickup_code_already_used', committed_lines: 0, aborted: false };
  }

  if (row.status === 'revoked' || row.status === 'expired') {
    return { ok: false, error_code: 'pickup_code_expired', committed_lines: 0, aborted: false };
  }

  if (row.expiresAt <= now) {
    row.status = 'expired';
    row.attempts += 1;
    return { ok: false, error_code: 'pickup_code_expired', committed_lines: 0, aborted: false };
  }

  if (row.attempts >= row.maxAttempts) {
    row.status = 'revoked';
    row.attempts += 1;
    return { ok: false, error_code: 'pickup_code_locked', committed_lines: 0, aborted: false };
  }

  // Reserva por si el commit falla (transacción).
  const snapshot: InventoryState = {
    onHand: inventory.onHand,
    reserved: inventory.reserved,
    movements: [...inventory.movements],
  };
  const previousStatus = row.status;

  row.status = 'redeemed';
  row.attempts += 1;

  try {
    const { committedLines } = commitOrder(inventory, orderId, lines);
    return { ok: true, error_code: null, committed_lines: committedLines, aborted: false };
  } catch {
    inventory.onHand = snapshot.onHand;
    inventory.reserved = snapshot.reserved;
    inventory.movements = snapshot.movements;
    row.status = previousStatus;
    return { ok: false, error_code: null, committed_lines: 0, aborted: true };
  }
}
