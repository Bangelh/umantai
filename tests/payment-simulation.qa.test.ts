// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { POST as simulateRoute } from '../app/api/admin/qa/simulate-payment/route';
import { isOrderFulfillmentBlocked, readOrderPaymentAudit, type Order, type OrderWithItems } from '../lib/commerce';
import type {
  ApplyApprovedPaymentInput,
  ApplyApprovedPaymentResult,
} from '../lib/payment-confirmation.server';
import {
  MP_PAYMENT_SIMULATION_ENV,
  SIMULATED_PAYMENT_PREFIX,
  buildSimulatedPayment,
  buildSimulatedPaymentId,
  evaluatePaymentSimulationGate,
  runPaymentSimulation,
} from '../lib/payment-simulation.server';
import {
  confirmOrderPaymentModel,
  type ConfirmIncomingPayment,
  type ConfirmOrderState,
} from './helpers/confirm-payment-model';
import {
  evaluatePickupGuard,
  evaluateReadyGuard,
} from './helpers/fulfillment-guard-model';

/**
 * Simulación de pago QA (Preview) — gates, idempotencia y reglas de fulfillment.
 *
 * ⚠️ LIMITACIÓN (igual que el resto de las suites de comercio): no hay Postgres ni
 * red. La confirmación real vive en PL/pgSQL (`confirm_order_payment`), así que los
 * tests de "simulación válida" inyectan `applyPayment` con
 * `confirmOrderPaymentModel` (el modelo de referencia del proyecto). Lo que se fija
 * acá es lo que SÍ vive en TypeScript y es el corazón de la simulación: el gate
 * fail-closed, el pago derivado del pedido real, la idempotencia del orquestador y
 * que un conflicto de stock/needsReview siga bloqueando el fulfillment.
 */

const NOW = '2026-10-08T12:00:00.000Z';
const ADMIN_SECRET = 'test-admin-secret-0123456789';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_NUMBER = 'ORD-QA-SIM-0001';

type EnvMap = Record<string, string | undefined>;

async function withEnv<T>(env: EnvMap, fn: () => Promise<T> | T): Promise<T> {
  const saved: EnvMap = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type RouteRequest = Parameters<typeof simulateRoute>[0];

function simulateRequest(body: unknown, token?: string): RouteRequest {
  return new Request('http://localhost/api/admin/qa/simulate-payment', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as RouteRequest;
}

/** Pedido base `pending_payment` con reserva viva. */
function baseOrder(overrides: Partial<ConfirmOrderState> = {}): ConfirmOrderState {
  return {
    total: 749,
    currency: 'PEN',
    status: 'pending_payment',
    paymentStatus: 'pending',
    paymentMethod: null,
    paymentReference: null,
    reservationReleased: false,
    version: 0,
    confirmedAt: null,
    metadata: {},
    ...overrides,
  };
}

/** Construye un `OrderWithItems` mínimo a partir del estado del modelo (solo lo que se usa). */
function toOrder(state: ConfirmOrderState): OrderWithItems {
  return {
    items: [],
    id: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    publicToken: '22222222-2222-4222-8222-222222222222',
    customerId: null,
    contactEmail: 'qa@testuser.com',
    contactPhone: null,
    channel: 'web' as Order['channel'],
    fulfillmentType: 'pickup' as Order['fulfillmentType'],
    lockerCode: null,
    status: state.status as Order['status'],
    paymentStatus: state.paymentStatus as Order['paymentStatus'],
    paymentMethod: state.paymentMethod,
    paymentReference: state.paymentReference,
    currency: state.currency,
    subtotal: state.total,
    discountTotal: 0,
    taxTotal: 0,
    shippingTotal: 0,
    total: state.total,
    itemCount: 1,
    shippingAddress: null,
    pickupInstructions: null,
    customerNote: null,
    reservationExpiresAt: null,
    reservationReleased: state.reservationReleased,
    confirmedAt: state.confirmedAt,
    readyAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    cancelledAt: null,
    cancelledReason: null,
    metadata: state.metadata,
    version: state.version,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * `applyPayment` falso: usa el modelo de referencia de `confirm_order_payment` y deja
 * memoria del pedido entre llamadas (como haría la base real). Cuenta cuántas veces se
 * pidió re-reservar stock, que es la prueba de que un reintento NO duplica movimientos.
 */
function makeFakeApplyPayment(initial: ConfirmOrderState, options: { rereserveThrows?: boolean } = {}) {
  const store = { state: initial };
  let rereserveCalls = 0;

  const applyPayment = async (
    input: ApplyApprovedPaymentInput,
  ): Promise<ApplyApprovedPaymentResult | null> => {
    const payment: ConfirmIncomingPayment = {
      id: input.paymentId,
      amount: input.paidAmount ?? null,
      currency: input.currency ?? null,
      paymentMethodId: input.paymentMethod ?? null,
      status: 'approved',
      statusDetail: (input.paymentMetadata?.statusDetail as string) ?? null,
      dateApproved: (input.paymentMetadata?.dateApproved as string) ?? null,
      rawSnapshot: { ...(input.paymentMetadata ?? {}), status: 'approved', source: input.source },
    };

    const { order } = confirmOrderPaymentModel(store.state, payment, {
      now: NOW,
      rereserve: () => {
        rereserveCalls += 1;
        if (options.rereserveThrows) throw new Error('insufficient_stock');
        return 1;
      },
    });
    store.state = order;

    const audit = readOrderPaymentAudit({ metadata: order.metadata });
    const fulfillmentBlocked = Boolean(
      audit?.stockConflict || audit?.needsReview || audit?.duplicatePayment,
    );

    return {
      order: toOrder(order),
      audit,
      fulfillmentBlocked,
      storeNotification: fulfillmentBlocked ? null : { status: 'sent' },
    };
  };

  return { applyPayment, store, rereserveCalls: () => rereserveCalls };
}

function guardOrder(order: ConfirmOrderState) {
  return { status: order.status, paymentStatus: order.paymentStatus, metadata: order.metadata };
}

// =============================================================================
//  1. GATES — imposible de usar en Producción
// =============================================================================

test('gate: Production queda bloqueado (404) incluso con flag y admin válidos', () => {
  const result = evaluatePaymentSimulationGate({
    vercelEnv: 'production',
    simulationFlag: '1',
    adminConfigured: true,
    adminTokenValid: true,
  });
  assert.deepEqual(result, { ok: false, status: 404, code: 'simulation_unavailable' });
});

test('gate: Preview sin MP_PAYMENT_SIMULATION=1 queda bloqueado (404)', () => {
  for (const flag of [undefined, '', '0', 'true', 'yes']) {
    const result = evaluatePaymentSimulationGate({
      vercelEnv: 'preview',
      simulationFlag: flag,
      adminConfigured: true,
      adminTokenValid: true,
    });
    assert.deepEqual(result, { ok: false, status: 404, code: 'simulation_unavailable' });
  }
});

test('gate: fuera de Vercel (VERCEL_ENV ausente) queda bloqueado (404)', () => {
  const result = evaluatePaymentSimulationGate({
    vercelEnv: undefined,
    simulationFlag: '1',
    adminConfigured: true,
    adminTokenValid: true,
  });
  assert.deepEqual(result, { ok: false, status: 404, code: 'simulation_unavailable' });
});

test('gate: Preview con flag pero sin autenticación administrativa queda bloqueado (403)', () => {
  const noConfig = evaluatePaymentSimulationGate({
    vercelEnv: 'preview',
    simulationFlag: '1',
    adminConfigured: false,
    adminTokenValid: false,
  });
  assert.deepEqual(noConfig, { ok: false, status: 403, code: 'simulation_forbidden' });

  const badToken = evaluatePaymentSimulationGate({
    vercelEnv: 'preview',
    simulationFlag: '1',
    adminConfigured: true,
    adminTokenValid: false,
  });
  assert.deepEqual(badToken, { ok: false, status: 403, code: 'simulation_forbidden' });
});

test('gate: Preview + flag=1 + admin válido es el ÚNICO caso permitido', () => {
  const result = evaluatePaymentSimulationGate({
    vercelEnv: 'preview',
    simulationFlag: '1',
    adminConfigured: true,
    adminTokenValid: true,
  });
  assert.deepEqual(result, { ok: true });
});

// ── Ruta real: el gate corta ANTES de tocar la base ──────────────────────────

test('ruta: Producción responde 404 aunque manden flag y token válidos', async () => {
  await withEnv(
    { VERCEL_ENV: 'production', [MP_PAYMENT_SIMULATION_ENV]: '1', ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const response = await simulateRoute(
        simulateRequest({ orderId: ORDER_ID }, ADMIN_SECRET),
      );
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'simulation_unavailable');
    },
  );
});

test('ruta: Preview con flag pero sin token responde 403', async () => {
  await withEnv(
    { VERCEL_ENV: 'preview', [MP_PAYMENT_SIMULATION_ENV]: '1', ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const response = await simulateRoute(simulateRequest({ orderId: ORDER_ID }));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'simulation_forbidden');
    },
  );
});

test('ruta: Preview sin flag responde 404 (ni siquiera llega a validar admin)', async () => {
  await withEnv(
    { VERCEL_ENV: 'preview', [MP_PAYMENT_SIMULATION_ENV]: undefined, ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const response = await simulateRoute(
        simulateRequest({ orderId: ORDER_ID }, ADMIN_SECRET),
      );
      assert.equal(response.status, 404);
    },
  );
});

// =============================================================================
//  2. PAGO SIMULADO derivado del pedido REAL
// =============================================================================

test('el pago simulado sale del pedido y nunca puede confundirse con Mercado Pago', () => {
  const order = toOrder(baseOrder());
  const payment = buildSimulatedPayment(order);

  assert.equal(payment.paymentId, buildSimulatedPaymentId(ORDER_ID));
  assert.ok(payment.paymentId.startsWith(SIMULATED_PAYMENT_PREFIX));
  // Un Payment ID real de Mercado Pago es numérico; esto no puede colisionar.
  assert.ok(!/^\d+$/.test(payment.paymentId));
  // Monto y moneda SIEMPRE del pedido, no del cliente.
  assert.equal(payment.paidAmount, order.total);
  assert.equal(payment.currency, order.currency);
  assert.equal(payment.source, 'simulation');
  assert.equal(order.orderNumber, ORDER_NUMBER);
});

test('el id de simulación es determinista por pedido (base de la idempotencia)', () => {
  assert.equal(buildSimulatedPaymentId(ORDER_ID), buildSimulatedPaymentId(ORDER_ID));
  assert.notEqual(buildSimulatedPaymentId(ORDER_ID), buildSimulatedPaymentId(`${ORDER_ID}x`));
});

// =============================================================================
//  3. SIMULACIÓN VÁLIDA → confirmed, con idempotencia
// =============================================================================

test('simulación válida: pending_payment → confirmed/paid, fulfillment permitido', async () => {
  const fake = makeFakeApplyPayment(baseOrder());
  const result = await runPaymentSimulation(ORDER_ID, {
    loadOrder: async () => (fake.store.state ? toOrder(fake.store.state) : null),
    applyPayment: fake.applyPayment,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.previousStatus, 'pending_payment');
  assert.equal(result.status, 'confirmed');
  assert.equal(result.paymentStatus, 'paid');
  assert.equal(result.applied, true);
  assert.equal(result.idempotentReason, null);
  assert.equal(result.fulfillmentBlocked, false);
  assert.equal(result.source, 'simulation');
  assert.equal(fake.store.state.version, 1, 'la confirmación movió la versión una vez');

  const audit = readOrderPaymentAudit({ metadata: fake.store.state.metadata });
  assert.equal(audit?.needsReview, false);
  assert.deepEqual(evaluateReadyGuard(guardOrder(fake.store.state)), { ok: true });
  assert.deepEqual(evaluatePickupGuard(guardOrder(fake.store.state)), { ok: true });
});

test('simular dos veces el MISMO pedido es idempotente: no re-confirma ni re-descuenta stock', async () => {
  // Reserva ya liberada por el reaper: la primera confirmación re-reserva (1 movimiento).
  const fake = makeFakeApplyPayment(baseOrder({ status: 'expired', reservationReleased: true }));
  const deps = {
    loadOrder: async () => toOrder(fake.store.state),
    applyPayment: fake.applyPayment,
  };

  const first = await runPaymentSimulation(ORDER_ID, deps);
  const second = await runPaymentSimulation(ORDER_ID, deps);

  assert.equal(first.ok && first.applied, true);
  assert.equal(second.ok && second.applied, false, 'el reintento NO vuelve a confirmar');
  assert.equal(second.ok && second.idempotentReason, 'already_applied');
  assert.equal(second.ok && second.status, 'confirmed');
  assert.equal(second.ok && second.paymentStatus, 'paid');

  // Una sola re-reserva: el reintento es no-op, no produce inventory movements duplicados.
  assert.equal(fake.rereserveCalls(), 1);
  assert.equal(fake.store.state.version, 1, 'el pedido se confirmó una sola vez');
});

test('si el pedido ya lo pagó otra fuente, la simulación no crea un falso pago duplicado', async () => {
  const fake = makeFakeApplyPayment(
    baseOrder({
      status: 'confirmed',
      paymentStatus: 'paid',
      paymentReference: '1234567890',
      metadata: { payment: { lastPaymentId: '1234567890' } },
    }),
  );
  const result = await runPaymentSimulation(ORDER_ID, {
    loadOrder: async () => toOrder(fake.store.state),
    applyPayment: fake.applyPayment,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.applied, false);
  assert.equal(result.idempotentReason, 'paid_by_other_source');
  assert.equal(fake.rereserveCalls(), 0);
});

// =============================================================================
//  4. STOCK CONFLICT → needsReview conservado, ready/pickup bloqueados
// =============================================================================

test('conflicto de stock: confirma igual, marca needsReview y bloquea ready/pickup', async () => {
  const fake = makeFakeApplyPayment(
    baseOrder({ status: 'expired', reservationReleased: true }),
    { rereserveThrows: true },
  );
  const result = await runPaymentSimulation(ORDER_ID, {
    loadOrder: async () => toOrder(fake.store.state),
    applyPayment: fake.applyPayment,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.status, 'confirmed', 'la verdad económica se conserva (pagó)');
  assert.equal(result.paymentStatus, 'paid');
  assert.equal(result.fulfillmentBlocked, true);
  assert.equal(result.storeNotified, false, 'no se avisa a la tienda para preparar');

  const audit = readOrderPaymentAudit({ metadata: fake.store.state.metadata });
  assert.equal(audit?.stockConflict, true);
  assert.equal(audit?.needsReview, true);
  assert.equal(isOrderFulfillmentBlocked({ metadata: fake.store.state.metadata }), true);

  // La guarda autoritativa (migración 006) rechaza el avance.
  assert.deepEqual(evaluateReadyGuard(guardOrder(fake.store.state)), {
    ok: false,
    code: 'order_requires_review',
  });
  assert.deepEqual(evaluatePickupGuard(guardOrder(fake.store.state)), {
    ok: false,
    code: 'order_requires_review',
  });
});

test('re-simular un pedido en conflicto no borra needsReview ni desbloquea el fulfillment', async () => {
  const fake = makeFakeApplyPayment(
    baseOrder({ status: 'expired', reservationReleased: true }),
    { rereserveThrows: true },
  );
  const deps = {
    loadOrder: async () => toOrder(fake.store.state),
    applyPayment: fake.applyPayment,
  };

  await runPaymentSimulation(ORDER_ID, deps);
  const second = await runPaymentSimulation(ORDER_ID, deps);

  assert.equal(second.ok && second.fulfillmentBlocked, true);
  const audit = readOrderPaymentAudit({ metadata: fake.store.state.metadata });
  assert.equal(audit?.needsReview, true);
  assert.deepEqual(evaluateReadyGuard(guardOrder(fake.store.state)), {
    ok: false,
    code: 'order_requires_review',
  });
});
