/**
 * lib/payment-simulation.server.ts — simulación CONTROLADA de pago para Preview (QA).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ ES Y QUÉ NO ES
 *
 *  Es una herramienta de QA para demostrar TODO el flujo interno (confirmado →
 *  preparado → listo → PIN → retiro → inventario) sin depender de que la página
 *  hospedada de Mercado Pago funcione en sandbox.
 *
 *  NO es un pago real, NO debilita la seguridad y NO puede usarse en Producción.
 *  Tres candados tienen que estar abiertos A LA VEZ:
 *
 *    1. `VERCEL_ENV === 'preview'`   → imposible en Producción por construcción.
 *    2. `MP_PAYMENT_SIMULATION === '1'` → apagado por defecto; hay que encenderlo.
 *    3. autenticación administrativa (`x-admin-token`) ya existente.
 *
 *  Si cualquiera falla, la ruta responde fail-closed (404/403) sin tocar la base.
 *  No hay fallback, ni enable por querystring/body, ni forma de habilitarlo en
 *  Producción.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  EN QUÉ PUNTO ENTRA AL FLUJO
 *
 *  La simulación se conecta EXACTAMENTE donde termina la validación externa de un
 *  webhook legítimo, y reutiliza la misma función interna:
 *
 *    WEBHOOK REAL           SIMULADOR (Preview)
 *    ────────────           ──────────────────
 *    firma HMAC             gate QA (3 candados)
 *    leer pago de MP        (se salta MP a propósito)
 *    pago aprobado    ───►  pago aprobado  ───►  applyApprovedPayment()
 *                                                      │
 *                                          confirmed / stock / notificaciones
 *
 *  `applyApprovedPayment` es el mismo código para ambos: la simulación NUNCA hace
 *  un UPDATE directo de `orders`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isAdminApiConfigured, verifyAdminToken, ADMIN_TOKEN_HEADER } from './admin.server';
import type { OrderStatus, OrderWithItems, PaymentStatus } from './commerce';
import { getOrderWithItems } from './commerce.server';
import { applyApprovedPayment, type ApplyApprovedPaymentInput } from './payment-confirmation.server';

/** Variable que enciende la simulación SOLO en Preview. */
export const MP_PAYMENT_SIMULATION_ENV = 'MP_PAYMENT_SIMULATION';

/** Prefijo inequívoco: un Payment ID real de Mercado Pago es numérico, esto no. */
export const SIMULATED_PAYMENT_PREFIX = 'SIMULATED-MP-';

// =============================================================================
//  1. GATE (función pura, testeable sin entorno ni base)
// =============================================================================

export interface PaymentSimulationGateInput {
  vercelEnv: string | null | undefined;
  simulationFlag: string | null | undefined;
  adminConfigured: boolean;
  adminTokenValid: boolean;
}

export type PaymentSimulationGate =
  | { ok: true }
  | { ok: false; status: 404 | 403; code: 'simulation_unavailable' | 'simulation_forbidden' };

/**
 * Los tres candados, en orden. Entorno o flag apagados → 404 (la ruta "no existe").
 * Autenticación administrativa ausente o inválida → 403.
 *
 * Es pura a propósito: no lee `process.env` ni toca la base, así que se puede probar
 * cada combinación sin Postgres (y sin poder "acordarse" de encenderse sola).
 */
export function evaluatePaymentSimulationGate(
  input: PaymentSimulationGateInput,
): PaymentSimulationGate {
  if (input.vercelEnv !== 'preview') {
    return { ok: false, status: 404, code: 'simulation_unavailable' };
  }
  if (input.simulationFlag !== '1') {
    return { ok: false, status: 404, code: 'simulation_unavailable' };
  }
  if (!input.adminConfigured || !input.adminTokenValid) {
    return { ok: false, status: 403, code: 'simulation_forbidden' };
  }
  return { ok: true };
}

/** Combina el gate con los valores reales del proceso y la petición. */
export function checkPaymentSimulationAccess(request: Request): PaymentSimulationGate {
  return evaluatePaymentSimulationGate({
    vercelEnv: process.env.VERCEL_ENV,
    simulationFlag: process.env[MP_PAYMENT_SIMULATION_ENV],
    adminConfigured: isAdminApiConfigured(),
    adminTokenValid: verifyAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),
  });
}

// =============================================================================
//  2. PAGO SIMULADO (server-side, derivado del pedido REAL)
// =============================================================================

/**
 * Id determinista por pedido.
 *
 * Determinista NO por capricho: es lo que hace idempotente al endpoint. Un id nuevo
 * en cada llamada haría que la segunda simulación sobre el mismo pedido pareciera un
 * SEGUNDO pago distinto (`duplicatePayment`) en vez del reintento del MISMO pago
 * (`no-op`). Con un id estable, simular dos veces no confirma ni descuenta dos veces.
 */
export function buildSimulatedPaymentId(orderId: string): string {
  return `${SIMULATED_PAYMENT_PREFIX}${orderId}`;
}

/**
 * Arma el pago simulado a partir del pedido. NADA viene del cliente: ni el monto,
 * ni la moneda, ni el resultado. Todo se lee del pedido real del servidor.
 */
export function buildSimulatedPayment(order: OrderWithItems): ApplyApprovedPaymentInput {
  return {
    paymentId: buildSimulatedPaymentId(order.id),
    orderNumber: order.orderNumber,
    paymentMethod: 'simulation_qa',
    paidAmount: order.total,
    currency: order.currency,
    liveMode: false,
    source: 'simulation',
    actor: 'qa:simulate-payment',
    paymentMetadata: {
      statusDetail: 'simulated_approved',
      paymentMethodId: 'simulation_qa',
      paymentTypeId: 'simulation',
      dateApproved: new Date().toISOString(),
      simulated: true,
    },
  };
}

// =============================================================================
//  3. ORQUESTACIÓN (dependencias inyectables para poder probar sin base)
// =============================================================================

export interface PaymentSimulationDeps {
  loadOrder?: (orderId: string) => Promise<OrderWithItems | null>;
  /** La MISMA función que usa el webhook real. */
  applyPayment?: (input: ApplyApprovedPaymentInput) => ReturnType<typeof applyApprovedPayment>;
}

export type PaymentSimulationResult =
  | { ok: false; code: 'order_not_found' }
  | {
      ok: true;
      orderId: string;
      orderNumber: string;
      previousStatus: OrderStatus;
      previousPaymentStatus: PaymentStatus;
      status: OrderStatus;
      paymentStatus: PaymentStatus;
      simulationId: string;
      /** false si el pedido ya estaba pagado (reintento = no-op idempotente). */
      applied: boolean;
      /** true si el fulfillment quedó bloqueado (stock/revisión/duplicado). */
      fulfillmentBlocked: boolean;
      storeNotified: boolean;
      /** Motivo de un no-op: reintento del mismo pago, o pedido ya pagado. */
      idempotentReason: 'already_applied' | 'paid_by_other_source' | null;
      source: 'simulation';
    };

/**
 * Ejecuta la simulación sobre un pedido REAL.
 *
 * No inventa monto ni estado: `buildSimulatedPayment` los saca del pedido. El único
 * dato del cliente es `orderId` (y que sea su pedido).
 */
export async function runPaymentSimulation(
  orderId: string,
  deps: PaymentSimulationDeps = {},
): Promise<PaymentSimulationResult> {
  const loadOrder = deps.loadOrder ?? getOrderWithItems;
  const applyPayment = deps.applyPayment ?? applyApprovedPayment;

  const order = await loadOrder(orderId);
  if (!order) return { ok: false, code: 'order_not_found' };

  const simulationId = buildSimulatedPaymentId(order.id);
  const previousStatus = order.status;
  const previousPaymentStatus = order.paymentStatus;

  // Guarda: si el pedido ya lo pagó OTRA cosa (un pago real), re-simularlo crearía un
  // falso "segundo pago distinto". Se devuelve el estado sin tocar nada.
  if (order.paymentStatus === 'paid' && order.paymentReference !== simulationId) {
    return {
      ok: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      previousStatus,
      previousPaymentStatus,
      status: order.status,
      paymentStatus: order.paymentStatus,
      simulationId,
      applied: false,
      fulfillmentBlocked: false,
      storeNotified: false,
      idempotentReason: 'paid_by_other_source',
      source: 'simulation',
    };
  }

  const applied = await applyPayment(buildSimulatedPayment(order));
  if (!applied) {
    // No debería pasar (el pedido existe), pero el `order_number` es la clave real.
    return { ok: false, code: 'order_not_found' };
  }

  // Reintento sobre un pedido ya simulado: applyApprovedPayment devolvió el pedido sin
  // cambios (no-op de `confirm_order_payment`), así que el estado no se movió.
  const wasAlreadySimulated = previousPaymentStatus === 'paid';

  return {
    ok: true,
    orderId: applied.order.id,
    orderNumber: applied.order.orderNumber,
    previousStatus,
    previousPaymentStatus,
    status: applied.order.status,
    paymentStatus: applied.order.paymentStatus,
    simulationId,
    applied: !wasAlreadySimulated,
    fulfillmentBlocked: applied.fulfillmentBlocked,
    storeNotified: Boolean(applied.storeNotification),
    idempotentReason: wasAlreadySimulated ? 'already_applied' : null,
    source: 'simulation',
  };
}
