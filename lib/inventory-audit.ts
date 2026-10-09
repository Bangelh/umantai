/**
 * lib/inventory-audit.ts — reconciliación READ-ONLY del ledger vs `inventory`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  INVARIANTE QUE ESTE MÓDULO VIGILA
 *
 *  `inventory_apply_movement()` (001_commerce_core.sql) actualiza
 *  `inventory.quantity_reserved` e INSERTA el movimiento en la MISMA sentencia, y el
 *  ledger es append-only (`prevent_ledger_mutation`). Por lo tanto:
 *
 *      inventory.quantity_reserved  ==  Σ reserved_delta  ==  reserved_after final
 *
 *  Si esa igualdad no se cumple, hubo una escritura FUERA del motor (UPDATE directo
 *  sobre `inventory`, movimiento con atribución rota, etc.). Este módulo detecta el
 *  primer punto exacto de divergencia, sin tocar la base.
 *
 *  Es puro (sin DB ni red): la query vive en `lib/commerce.server.ts` y acá sólo se
 *  decide, sobre las filas ya leídas, dónde está la inconsistencia.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Tipos de movimiento que forman el ciclo de vida de una reserva. */
export const RESERVATION_LIFECYCLE_TYPES = ['reservation', 'reservation_release', 'sale'] as const;
export type ReservationLifecycleMovement = (typeof RESERVATION_LIFECYCLE_TYPES)[number];

/** Movimiento del ledger ya normalizado para la auditoría (number/null, no strings). */
export interface InventoryMovementAudit {
  id: string;
  orderId: string | null;
  orderItemId: string | null;
  movementType: string;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  idempotencyKey: string | null;
  reason: string | null;
  performedBy: string | null;
  createdAt: string;
  variantKey: string;
}

function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orden cronológico (created_at y, a igualdad, el `id` del ledger como desempate).
 * El desempate importa: dos movimientos del mismo milisegundo deben evaluarse en el
 * orden real de inserción o la suma corrida miente.
 */
export function sortMovementsChronologically<T extends { createdAt: string; id: string }>(
  movements: T[],
): T[] {
  return [...movements].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (byTime !== 0) return byTime;
    return compareIds(a.id, b.id);
  });
}

/**
 * Último movimiento del ciclo de vida de una línea.
 *
 * ESTA es la definición autoritativa de "la línea retiene stock HOY": la usa
 * `inventory_rereserve_order()`. Una línea liberada y RE-RESERVADA por un pago tardío
 * vuelve a tener `reservation` como último movimiento, aunque antes hubiera un
 * `reservation_release`.
 */
export function latestLifecycleMovement(
  movements: InventoryMovementAudit[],
): ReservationLifecycleMovement | null {
  const ordered = sortMovementsChronologically(movements).filter((m) =>
    (RESERVATION_LIFECYCLE_TYPES as readonly string[]).includes(m.movementType),
  );
  const last = ordered.at(-1);
  return last ? (last.movementType as ReservationLifecycleMovement) : null;
}

export interface ReservedDivergence {
  movementId: string;
  createdAt: string;
  movementType: string;
  /** Σ reserved_delta hasta este movimiento inclusive. */
  reservedRunningTotal: number;
  /** `reserved_after` persistido en el movimiento. Si difieren, hubo escritura fuera del motor. */
  reservedAfter: number;
}

export interface ReservedReconciliation {
  variantKey: string;
  movementCount: number;
  /** Σ cronológica de `reserved_delta`: el reserved esperado según el ledger. */
  reservedLedgerSum: number;
  /** `reserved_after` del último movimiento (lo que el motor cree que quedó). */
  ledgerFinalReserved: number;
  /** `inventory.quantity_reserved` actual. */
  inventoryReserved: number;
  matchesInventory: boolean;
  /** Primer movimiento donde la suma corrida no coincide con `reserved_after`. */
  firstDivergence: ReservedDivergence | null;
}

export function reconcileReservedDeltas(
  movements: InventoryMovementAudit[],
  inventoryReserved: number,
  variantKey = '',
): ReservedReconciliation {
  const ordered = sortMovementsChronologically(movements);

  let running = 0;
  let lastAfter = 0;
  let firstDivergence: ReservedDivergence | null = null;

  for (const movement of ordered) {
    running += movement.reservedDelta;
    lastAfter = movement.reservedAfter;
    if (firstDivergence === null && movement.reservedAfter !== running) {
      firstDivergence = {
        movementId: movement.id,
        createdAt: movement.createdAt,
        movementType: movement.movementType,
        reservedRunningTotal: running,
        reservedAfter: movement.reservedAfter,
      };
    }
  }

  return {
    variantKey,
    movementCount: ordered.length,
    reservedLedgerSum: running,
    ledgerFinalReserved: ordered.length > 0 ? lastAfter : 0,
    inventoryReserved,
    matchesInventory: running === inventoryReserved,
    firstDivergence,
  };
}

export interface ReservationLineAudit {
  orderItemId: string | null;
  orderId: string | null;
  /** Último movimiento del ciclo de vida (reservation / reservation_release / sale). */
  latestMovement: ReservationLifecycleMovement | null;
  /** Unidades retenidas según el ledger (0 si el último movimiento no es `reservation`). */
  heldUnits: number;
  movementCount: number;
}

/**
 * Agrupa los movimientos por línea (`order_item_id`) y clasifica si cada una retiene
 * stock AHORA. Los movimientos sin `order_item_id` no se pueden atribuir a ninguna
 * línea: se devuelven aparte (`unattributed`) porque son una causa posible de que
 * `quantity_reserved` no cuadre con ninguna reserva identificable.
 */
export function classifyReservationLines(movements: InventoryMovementAudit[]): {
  lines: ReservationLineAudit[];
  unattributed: InventoryMovementAudit[];
} {
  const byItem = new Map<string, InventoryMovementAudit[]>();
  const unattributed: InventoryMovementAudit[] = [];

  for (const movement of movements) {
    if (!movement.orderItemId) {
      unattributed.push(movement);
      continue;
    }
    const bucket = byItem.get(movement.orderItemId) ?? [];
    bucket.push(movement);
    byItem.set(movement.orderItemId, bucket);
  }

  const lines: ReservationLineAudit[] = [];
  for (const [orderItemId, bucket] of byItem) {
    const ordered = sortMovementsChronologically(bucket).filter((m) =>
      (RESERVATION_LIFECYCLE_TYPES as readonly string[]).includes(m.movementType),
    );
    const last = ordered.at(-1);
    const latestMovement = last ? (last.movementType as ReservationLifecycleMovement) : null;
    lines.push({
      orderItemId,
      orderId: bucket[0]?.orderId ?? null,
      latestMovement,
      heldUnits: latestMovement === 'reservation' ? Math.max(last!.reservedDelta, 0) : 0,
      movementCount: bucket.length,
    });
  }

  lines.sort((a, b) => (a.orderItemId ?? '').localeCompare(b.orderItemId ?? ''));
  return { lines, unattributed };
}
