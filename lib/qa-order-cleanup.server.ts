/**
 * lib/qa-order-cleanup.server.ts — limpieza CONTROLADA de pedidos QA en Preview.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ ES Y QUÉ NO ES
 *
 *  Los pedidos QA de la demo quedan en estados OPERATIVOS (`confirmed` / `preparing`
 *  / `ready_for_pickup`) y nunca se limpian solos: el reaper (`expire_stale_orders`)
 *  solo toca `pending_payment`. Esta herramienta los cierra por la MISMA vía
 *  sancionada que usaría operación, conservando todo el historial.
 *
 *  NO borra nada. NO hace UPDATE directo de inventario. NO ejecuta SQL manual: llama a
 *  `inventory_release_order()` (el motor del ledger) y a la máquina de estados.
 *
 *  ─── LOS TRES CANDADOS (los tres a la vez, sin fallback) ────────────────────
 *    1. `VERCEL_ENV === 'preview'`        → imposible en Producción por construcción.
 *    2. `QA_CLEANUP === '1'`              → apagado por defecto; hay que encenderlo.
 *    3. autenticación administrativa (`x-admin-token`) ya existente.
 *
 *  Si el entorno o el flag están apagados → 404 (la ruta "no existe").
 *  Si la autenticación falla → 403. Nunca se habilita por body/query.
 *
 *  ─── ALCANCE ────────────────────────────────────────────────────────────────
 *  Solo IDs EXPLÍCITOS que llegan en el body. No hay "cancelar todo", ni búsqueda por
 *  estado como escritura masiva, ni forma de que un filtro amplíe el alcance.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ADMIN_TOKEN_HEADER, isAdminApiConfigured, verifyAdminToken } from './admin.server';
import type { AdminOrderView } from './admin-order-view';
import type { OrderStatus, OrderWithItems } from './commerce';
import { cancelOrderForQa, getOrderWithItems, listAdminOrders } from './commerce.server';

/** Variable que enciende la limpieza QA SOLO en Preview. */
export const QA_CLEANUP_ENV = 'QA_CLEANUP';

/** Motivo con el que queda auditado cada cierre (en el pedido y en el ledger). */
export const QA_CLEANUP_REASON = 'qa_cleanup';

/**
 * Estados que ensucian el kiosco. Es una lista CERRADA: cualquier otro estado se
 * rechaza (fail-closed) aunque el ID sea válido.
 */
export const QA_CLEANUP_TARGET_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'preparing',
  'ready_for_pickup',
];

/** Tope defensivo: una limpieza QA no necesita más que esto por llamada. */
export const QA_CLEANUP_MAX_ORDER_IDS = 50;

// =============================================================================
//  1. GATE (puro: no lee entorno ni toca la base, así se prueba completo)
// =============================================================================

export interface QaCleanupGateInput {
  vercelEnv: string | null | undefined;
  cleanupFlag: string | null | undefined;
  adminConfigured: boolean;
  adminTokenValid: boolean;
}

export type QaCleanupGate =
  | { ok: true }
  | { ok: false; status: 404 | 403; code: 'qa_cleanup_unavailable' | 'qa_cleanup_forbidden' };

/**
 * Los tres candados, en orden. Entorno o flag apagados → 404 (mismo cuerpo que "no
 * existe"). Autenticación administrativa ausente o inválida → 403.
 */
export function evaluateQaCleanupGate(input: QaCleanupGateInput): QaCleanupGate {
  if (input.vercelEnv !== 'preview') {
    return { ok: false, status: 404, code: 'qa_cleanup_unavailable' };
  }
  if (input.cleanupFlag !== '1') {
    return { ok: false, status: 404, code: 'qa_cleanup_unavailable' };
  }
  if (!input.adminConfigured || !input.adminTokenValid) {
    return { ok: false, status: 403, code: 'qa_cleanup_forbidden' };
  }
  return { ok: true };
}

/** Combina el gate con los valores reales del proceso y la petición. */
export function checkQaCleanupAccess(request: Request): QaCleanupGate {
  return evaluateQaCleanupGate({
    vercelEnv: process.env.VERCEL_ENV,
    cleanupFlag: process.env[QA_CLEANUP_ENV],
    adminConfigured: isAdminApiConfigured(),
    adminTokenValid: verifyAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),
  });
}

// =============================================================================
//  2. ELEGIBILIDAD (pura)
// =============================================================================

export type QaCancelEligibility =
  | { allowed: true; alreadyCancelled: boolean }
  | { allowed: false; code: 'order_not_eligible'; status: OrderStatus | null };

/**
 * ¿Se puede cerrar este pedido con la limpieza QA?
 *
 *   · `confirmed` / `preparing` / `ready_for_pickup` → sí (son los que ensucian el kiosco).
 *   · `cancelled` → sí, pero es un no-op idempotente (`alreadyCancelled: true`).
 *   · cualquier otro (`pending_payment`, `picked_up`, `completed`, `expired`,
 *     `refunded`, `out_for_delivery`, `delivered`) → NO. Un pedido ya retirado o
 *     completado no se "limpia": eso sería reescribir historia de negocio.
 */
export function evaluateQaCancelEligibility(
  status: OrderStatus | null | undefined,
): QaCancelEligibility {
  if (!status) return { allowed: false, code: 'order_not_eligible', status: null };
  if (status === 'cancelled') return { allowed: true, alreadyCancelled: true };
  if (QA_CLEANUP_TARGET_STATUSES.includes(status)) {
    return { allowed: true, alreadyCancelled: false };
  }
  return { allowed: false, code: 'order_not_eligible', status };
}

// =============================================================================
//  3. ORQUESTACIÓN (dependencias inyectables: se prueba sin base)
// =============================================================================

/** Validación barata antes del cast `::uuid` de Postgres. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QaCancelOutcome {
  orderId: string;
  ok: boolean;
  orderNumber?: string;
  previousStatus?: OrderStatus;
  status?: OrderStatus;
  /** Líneas cuya reserva se soltó en esta llamada (0 en un no-op idempotente). */
  releasedLines?: number;
  /** PINs vigentes revocados en esta llamada (0 si ya estaba revocado). */
  revokedCodes?: number;
  alreadyCancelled?: boolean;
  error?:
    | 'invalid_order_id'
    | 'order_not_found'
    | 'order_not_eligible'
    | 'cancel_failed';
  message?: string;
}

export interface QaOrderCleanupSummary {
  cancelled: number;
  alreadyCancelled: number;
  failed: number;
  results: QaCancelOutcome[];
}

export interface QaOrderCleanupDeps {
  loadOrder?: (orderId: string) => Promise<OrderWithItems | null>;
  cancelForQa?: (
    orderId: string,
    reason?: string,
  ) => Promise<{
    orderNumber: string;
    previousStatus: OrderStatus;
    status: OrderStatus;
    releasedLines: number;
    revokedCodes: number;
    alreadyCancelled: boolean;
  }>;
}

/**
 * Cierra cada pedido en SU PROPIA transacción (la atomicidad por pedido vive en
 * `cancelOrderForQa`: revocar PIN + liberar reserva + transición, todo junto o nada).
 *
 * Un pedido que falla NO revierte a los demás: la herramienta sigue y reporta el
 * resultado por ID, porque en una limpieza QA lo peor sería un lote a medias sin saber
 * cuál quedó y cuál no.
 */
export async function runQaOrderCleanup(
  orderIds: string[],
  deps: QaOrderCleanupDeps = {},
): Promise<QaOrderCleanupSummary> {
  const loadOrder = deps.loadOrder ?? getOrderWithItems;
  const cancelForQa = deps.cancelForQa ?? cancelOrderForQa;

  const results: QaCancelOutcome[] = [];
  let cancelled = 0;
  let alreadyCancelled = 0;
  let failed = 0;

  for (const orderId of orderIds) {
    if (!UUID_PATTERN.test(orderId)) {
      failed += 1;
      results.push({ orderId, ok: false, error: 'invalid_order_id', message: 'No es un UUID.' });
      continue;
    }

    const order = await loadOrder(orderId);
    if (!order) {
      failed += 1;
      results.push({ orderId, ok: false, error: 'order_not_found', message: 'El pedido no existe.' });
      continue;
    }

    const eligibility = evaluateQaCancelEligibility(order.status);
    if (!eligibility.allowed) {
      failed += 1;
      results.push({
        orderId,
        ok: false,
        orderNumber: order.orderNumber,
        previousStatus: order.status,
        error: 'order_not_eligible',
        message: `Estado no limpiable: ${order.status}.`,
      });
      continue;
    }

    try {
      const result = await cancelForQa(orderId, QA_CLEANUP_REASON);
      if (result.alreadyCancelled) alreadyCancelled += 1;
      else cancelled += 1;
      results.push({ orderId, ok: true, ...result });
    } catch (error) {
      failed += 1;
      results.push({
        orderId,
        ok: false,
        orderNumber: order.orderNumber,
        previousStatus: order.status,
        error: 'cancel_failed',
        message: error instanceof Error ? error.message : 'Fallo inesperado.',
      });
    }
  }

  return { cancelled, alreadyCancelled, failed, results };
}

// =============================================================================
//  4. LISTADO (delegación fina para que la ruta no conozca la base)
// =============================================================================

/** Pedidos operativos (los que aparecen o podrían aparecer en el kiosco). */
export async function listQaVisibleOrders(
  options: { statuses?: OrderStatus[]; limit?: number } = {},
): Promise<AdminOrderView[]> {
  return listAdminOrders({
    statuses: options.statuses ?? [...QA_CLEANUP_TARGET_STATUSES],
    limit: options.limit,
  });
}
