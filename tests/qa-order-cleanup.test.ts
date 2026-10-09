// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET as listOrdersRoute } from '../app/api/admin/orders/route';
import { POST as cancelRoute } from '../app/api/admin/orders/cancel/route';
import type {
  AdminInventoryMovementView,
  AdminOrderView,
  AdminReservationLineInput,
} from '../lib/admin-order-view';
import {
  isActivelyReservedLine,
  toAdminOrderView,
  toAdminReservationHolderView,
} from '../lib/admin-order-view';
import type { OrderItemRow, OrderRow, OrderStatus, OrderWithItems, PickupCodeRow } from '../lib/commerce';
import {
  QA_CLEANUP_ENV,
  QA_CLEANUP_MAX_ORDER_IDS,
  QA_CLEANUP_REASON,
  evaluateQaCancelEligibility,
  evaluateQaCleanupGate,
  runQaOrderCleanup,
} from '../lib/qa-order-cleanup.server';
import {
  available,
  newInventory,
  redeemPickupCodeModel,
  releaseOrder,
  type InventoryState,
  type OrderLine,
  type PickupCodeState,
} from './helpers/qa-cleanup-model';

/**
 * Limpieza QA de pedidos (Preview) — candados, alcance, idempotencia y PIN.
 *
 * ⚠️ LIMITACIÓN (igual que el resto de las suites de comercio): no hay Postgres ni red.
 * El cierre real vive en PL/pgSQL (`inventory_release_order`, la máquina de estados) y
 * el canje en `redeem_pickup_code()`; acá se prueba lo que SÍ vive en TypeScript (gate,
 * elegibilidad, orquestación, redacción de la vista) y, con los MODELOS DE REFERENCIA de
 * `tests/helpers/qa-cleanup-model.ts`, la semántica que el SQL debe cumplir.
 */

const ADMIN_SECRET = 'test-admin-secret-0123456789';
const NOW = Date.now();

const ORDER_CONFIRMED = '11111111-1111-4111-8111-111111111111';
const ORDER_PREPARING = '22222222-2222-4222-8222-222222222222';
const ORDER_READY = '33333333-3333-4333-8333-333333333333';

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

type CancelRequest = Parameters<typeof cancelRoute>[0];
type ListRequest = Parameters<typeof listOrdersRoute>[0];

function postJson(url: string, body: unknown, token?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

// =============================================================================
//  Tienda en memoria: pedidos + PINs + inventario (modelos de referencia)
// =============================================================================

interface FakeOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  lines: OrderLine[];
}

interface FakeWorld {
  orders: Map<string, FakeOrder>;
  pickups: PickupCodeState[];
  inventory: InventoryState;
  /** Estado inicial del inventario, para comparar contra el final. */
  initial: { onHand: number; reserved: number };
}

/**
 * Espeja, en el mismo orden, lo que hace `cancelOrderForQa()`:
 * revocar PINs emitidos → liberar reserva → transicionar a `cancelled`.
 */
function makeFakeCleanup(world: FakeWorld) {
  const calls: string[] = [];

  const cancelForQa = async (orderId: string, reason = QA_CLEANUP_REASON) => {
    calls.push(orderId);
    const order = world.orders.get(orderId);
    if (!order) throw new Error('order_not_found');

    const previousStatus = order.status;

    // 1) Revocar los PINs vigentes (idempotente: sólo toca `issued`).
    let revokedCodes = 0;
    for (const pickup of world.pickups) {
      if (pickup.orderId === orderId && pickup.status === 'issued') {
        pickup.status = 'revoked';
        revokedCodes += 1;
      }
    }

    // 2) Liberar la reserva (no-op si ya se soltó o se vendió).
    const { releasedLines } = releaseOrder(world.inventory, orderId, order.lines, reason);

    // 3) Transición (el trigger de la BD es la autoridad).
    order.status = 'cancelled';

    return {
      orderNumber: order.orderNumber,
      previousStatus,
      status: order.status,
      releasedLines,
      revokedCodes,
      alreadyCancelled: previousStatus === 'cancelled',
    };
  };

  return { cancelForQa, calls };
}

function makeWorld(options: {
  onHand: number;
  reserved: number;
  orders: Array<{ id: string; orderNumber: string; status: OrderStatus; quantity: number }>;
  pickups?: Array<{ code: string; orderId: string; status: PickupCodeState['status'] }>;
}): FakeWorld {
  const orders = new Map<string, FakeOrder>();
  const pickups: PickupCodeState[] = [];
  const inventory = newInventory(options.onHand, options.reserved);

  options.orders.forEach((seed, index) => {
    const itemId = `${index + 1}${'0'.repeat(7)}-0000-4000-8000-00000000000${index + 1}`;
    const line: OrderLine = { orderItemId: itemId, quantity: seed.quantity };
    orders.set(seed.id, {
      id: seed.id,
      orderNumber: seed.orderNumber,
      status: seed.status,
      lines: [line],
    });

    // La reserva viva ya existe (la creó el checkout).
    inventory.movements.push({
      movementType: 'reservation',
      onHandDelta: 0,
      reservedDelta: seed.quantity,
      orderId: seed.id,
      orderItemId: itemId,
      idempotencyKey: `reserve:${seed.id}:${itemId}`,
      reason: 'order reservation',
    });
  });

  for (const pickup of options.pickups ?? []) {
    pickups.push({
      code: pickup.code,
      orderId: pickup.orderId,
      status: pickup.status,
      attempts: 0,
      maxAttempts: 5,
      expiresAt: NOW + 60 * 60 * 1000,
    });
  }

  return {
    orders,
    pickups,
    inventory,
    initial: { onHand: options.onHand, reserved: options.reserved },
  };
}

function loadOrderFrom(world: FakeWorld) {
  return async (orderId: string): Promise<OrderWithItems | null> => {
    const order = world.orders.get(orderId);
    if (!order) return null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      items: [],
    } as unknown as OrderWithItems;
  };
}

// =============================================================================
//  1. GATES — imposible de usar fuera de Preview
// =============================================================================

test('gate: Producción queda bloqueado (404) aunque el flag y el admin estén bien', () => {
  const result = evaluateQaCleanupGate({
    vercelEnv: 'production',
    cleanupFlag: '1',
    adminConfigured: true,
    adminTokenValid: true,
  });
  assert.deepEqual(result, { ok: false, status: 404, code: 'qa_cleanup_unavailable' });
});

test('gate: Preview sin QA_CLEANUP=1 queda bloqueado (404)', () => {
  for (const flag of [undefined, '', '0', 'true', 'yes', 'TRUE']) {
    const result = evaluateQaCleanupGate({
      vercelEnv: 'preview',
      cleanupFlag: flag,
      adminConfigured: true,
      adminTokenValid: true,
    });
    assert.deepEqual(result, { ok: false, status: 404, code: 'qa_cleanup_unavailable' });
  }
});

test('gate: fuera de Vercel (VERCEL_ENV ausente) queda bloqueado (404)', () => {
  assert.deepEqual(
    evaluateQaCleanupGate({
      vercelEnv: undefined,
      cleanupFlag: '1',
      adminConfigured: true,
      adminTokenValid: true,
    }),
    { ok: false, status: 404, code: 'qa_cleanup_unavailable' },
  );
});

test('gate: Preview con flag pero sin autenticación administrativa queda bloqueado (403)', () => {
  assert.deepEqual(
    evaluateQaCleanupGate({
      vercelEnv: 'preview',
      cleanupFlag: '1',
      adminConfigured: false,
      adminTokenValid: false,
    }),
    { ok: false, status: 403, code: 'qa_cleanup_forbidden' },
  );

  assert.deepEqual(
    evaluateQaCleanupGate({
      vercelEnv: 'preview',
      cleanupFlag: '1',
      adminConfigured: true,
      adminTokenValid: false,
    }),
    { ok: false, status: 403, code: 'qa_cleanup_forbidden' },
  );
});

test('gate: Preview + flag=1 + admin válido es el ÚNICO caso permitido', () => {
  assert.deepEqual(
    evaluateQaCleanupGate({
      vercelEnv: 'preview',
      cleanupFlag: '1',
      adminConfigured: true,
      adminTokenValid: true,
    }),
    { ok: true },
  );
});

// ── Rutas reales: el gate corta ANTES de tocar la base ───────────────────────

test('ruta cancel: Producción responde 404 aunque manden flag y token válidos', async () => {
  await withEnv(
    { VERCEL_ENV: 'production', [QA_CLEANUP_ENV]: '1', ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const response = await cancelRoute(
        postJson('http://localhost/api/admin/orders/cancel', { orderIds: [ORDER_CONFIRMED] }, ADMIN_SECRET) as unknown as CancelRequest,
      );
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'qa_cleanup_unavailable');
    },
  );
});

test('ruta cancel: Preview sin flag responde 404 (ni siquiera llega a validar admin)', async () => {
  await withEnv(
    { VERCEL_ENV: 'preview', [QA_CLEANUP_ENV]: undefined, ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const response = await cancelRoute(
        postJson('http://localhost/api/admin/orders/cancel', { orderIds: [ORDER_CONFIRMED] }, ADMIN_SECRET) as unknown as CancelRequest,
      );
      assert.equal(response.status, 404);
    },
  );
});

test('ruta cancel: Preview con flag pero sin token (o con token inválido) responde 403', async () => {
  await withEnv(
    { VERCEL_ENV: 'preview', [QA_CLEANUP_ENV]: '1', ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const noToken = await cancelRoute(
        postJson('http://localhost/api/admin/orders/cancel', { orderIds: [ORDER_CONFIRMED] }) as unknown as CancelRequest,
      );
      assert.equal(noToken.status, 403);
      assert.equal((await noToken.json()).code, 'qa_cleanup_forbidden');

      const badToken = await cancelRoute(
        postJson('http://localhost/api/admin/orders/cancel', { orderIds: [ORDER_CONFIRMED] }, 'nope') as unknown as CancelRequest,
      );
      assert.equal(badToken.status, 403);
    },
  );
});

test('ruta cancel: sin IDs explícitos no hay limpieza posible (400, sin tocar la base)', async () => {
  await withEnv(
    { VERCEL_ENV: 'preview', [QA_CLEANUP_ENV]: '1', ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      for (const body of [{}, { orderIds: [] }, { orderIds: 'all' }, { orderIds: null }, { status: 'ready_for_pickup' }]) {
        const response = await cancelRoute(
          postJson('http://localhost/api/admin/orders/cancel', body, ADMIN_SECRET) as unknown as CancelRequest,
        );
        assert.equal(response.status, 400, `body rechazado: ${JSON.stringify(body)}`);
        assert.equal((await response.json()).code, 'invalid_order_ids');
      }
    },
  );
});

test('ruta cancel: rechaza más de QA_CLEANUP_MAX_ORDER_IDS por llamada', async () => {
  await withEnv(
    { VERCEL_ENV: 'preview', [QA_CLEANUP_ENV]: '1', ADMIN_API_SECRET: ADMIN_SECRET },
    async () => {
      const orderIds = Array.from({ length: QA_CLEANUP_MAX_ORDER_IDS + 1 }, () => ORDER_CONFIRMED);
      const response = await cancelRoute(
        postJson('http://localhost/api/admin/orders/cancel', { orderIds }, ADMIN_SECRET) as unknown as CancelRequest,
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'too_many_order_ids');
    },
  );
});

test('ruta listado: es read-only y exige x-admin-token (401 sin token o con token inválido)', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    const noToken = await listOrdersRoute(
      new Request('http://localhost/api/admin/orders') as unknown as ListRequest,
    );
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).code, 'admin_unauthorized');

    const badToken = await listOrdersRoute(
      new Request('http://localhost/api/admin/orders', { headers: { 'x-admin-token': 'nope' } }) as unknown as ListRequest,
    );
    assert.equal(badToken.status, 401);
  });
});

// =============================================================================
//  2. ELEGIBILIDAD — sólo estados operativos
// =============================================================================

test('elegibilidad: los tres estados operativos se pueden cerrar', () => {
  for (const status of ['confirmed', 'preparing', 'ready_for_pickup'] as OrderStatus[]) {
    assert.deepEqual(evaluateQaCancelEligibility(status), { allowed: true, alreadyCancelled: false });
  }
});

test('elegibilidad: `cancelled` se permite pero se reporta como no-op idempotente', () => {
  assert.deepEqual(evaluateQaCancelEligibility('cancelled'), {
    allowed: true,
    alreadyCancelled: true,
  });
});

test('elegibilidad: cualquier otro estado se rechaza (no se reescribe historia de negocio)', () => {
  const blocked: Array<OrderStatus | null | undefined> = [
    'pending_payment',
    'picked_up',
    'completed',
    'expired',
    'refunded',
    'out_for_delivery',
    'delivered',
    null,
    undefined,
  ];
  for (const status of blocked) {
    const result = evaluateQaCancelEligibility(status);
    assert.equal(result.allowed, false, `no debería permitirse: ${String(status)}`);
    assert.equal(result.allowed === false && result.code, 'order_not_eligible');
  }
});

// =============================================================================
//  3. ORQUESTACIÓN — por pedido, sin abortar el lote
// =============================================================================

test('limpieza: cierra confirmed, preparing y ready_for_pickup en una sola llamada', async () => {
  const world = makeWorld({
    onHand: 30,
    reserved: 3,
    orders: [
      { id: ORDER_CONFIRMED, orderNumber: 'QA-1', status: 'confirmed', quantity: 1 },
      { id: ORDER_PREPARING, orderNumber: 'QA-2', status: 'preparing', quantity: 1 },
      { id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 1 },
    ],
  });
  const fake = makeFakeCleanup(world);

  const summary = await runQaOrderCleanup([ORDER_CONFIRMED, ORDER_PREPARING, ORDER_READY], {
    loadOrder: loadOrderFrom(world),
    cancelForQa: fake.cancelForQa,
  });

  assert.equal(summary.cancelled, 3);
  assert.equal(summary.failed, 0);
  assert.deepEqual(
    summary.results.map((result) => result.previousStatus),
    ['confirmed', 'preparing', 'ready_for_pickup'],
  );
  for (const order of world.orders.values()) assert.equal(order.status, 'cancelled');
});

test('limpieza: un ID malo no aborta el lote y se reporta por pedido', async () => {
  const world = makeWorld({
    onHand: 20,
    reserved: 2,
    orders: [
      { id: ORDER_CONFIRMED, orderNumber: 'QA-1', status: 'confirmed', quantity: 1 },
      { id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 1 },
    ],
  });
  const fake = makeFakeCleanup(world);

  const notFound = '99999999-9999-4999-8999-999999999999';
  const summary = await runQaOrderCleanup(
    ['not-a-uuid', notFound, ORDER_CONFIRMED, ORDER_READY],
    { loadOrder: loadOrderFrom(world), cancelForQa: fake.cancelForQa },
  );

  assert.equal(summary.cancelled, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.results[0].error, 'invalid_order_id');
  assert.equal(summary.results[1].error, 'order_not_found');
  assert.equal(summary.results[2].ok, true);
  assert.equal(summary.results[3].ok, true);
});

test('limpieza: un pedido ya retirado se rechaza sin tocarle nada', async () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 1,
    orders: [{ id: ORDER_CONFIRMED, orderNumber: 'QA-1', status: 'picked_up', quantity: 1 }],
  });
  const fake = makeFakeCleanup(world);

  const summary = await runQaOrderCleanup([ORDER_CONFIRMED], {
    loadOrder: loadOrderFrom(world),
    cancelForQa: fake.cancelForQa,
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].error, 'order_not_eligible');
  assert.equal(world.orders.get(ORDER_CONFIRMED)!.status, 'picked_up');
  assert.deepEqual(fake.calls, [], 'no se llamó al cierre');
});

test('limpieza: un fallo del cierre se reporta y el lote sigue', async () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 2,
    orders: [
      { id: ORDER_CONFIRMED, orderNumber: 'QA-1', status: 'confirmed', quantity: 1 },
      { id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 1 },
    ],
  });
  const fake = makeFakeCleanup(world);

  const summary = await runQaOrderCleanup([ORDER_CONFIRMED, ORDER_READY], {
    loadOrder: loadOrderFrom(world),
    cancelForQa: async (orderId, reason) => {
      if (orderId === ORDER_CONFIRMED) throw new Error('invalid_order_transition');
      return fake.cancelForQa(orderId, reason);
    },
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].error, 'cancel_failed');
  assert.equal(summary.results[1].ok, true);
  assert.equal(world.orders.get(ORDER_READY)!.status, 'cancelled');
});

test('limpieza: la segunda corrida es un no-op idempotente (no re-libera ni re-revoca)', async () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 1,
    orders: [{ id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 1 }],
    pickups: [{ code: '482913', orderId: ORDER_READY, status: 'issued' }],
  });
  const fake = makeFakeCleanup(world);
  const deps = { loadOrder: loadOrderFrom(world), cancelForQa: fake.cancelForQa };

  const first = await runQaOrderCleanup([ORDER_READY], deps);
  const second = await runQaOrderCleanup([ORDER_READY], deps);

  assert.equal(first.results[0].releasedLines, 1);
  assert.equal(first.results[0].revokedCodes, 1);

  assert.equal(second.alreadyCancelled, 1);
  assert.equal(second.results[0].releasedLines, 0, 'no vuelve a liberar stock');
  assert.equal(second.results[0].revokedCodes, 0, 'no vuelve a revocar el PIN');

  // Un solo movimiento de liberación en todo el ledger.
  const releases = world.inventory.movements.filter((m) => m.movementType === 'reservation_release');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].idempotencyKey, `release:${ORDER_READY}:${world.orders.get(ORDER_READY)!.lines[0].orderItemId}`);
});

// =============================================================================
//  4. INVENTARIO — liberar NO descuenta on_hand
// =============================================================================

test('liberar la reserva: on_hand NO cambia, reserved baja y available sube', () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 3,
    orders: [{ id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 3 }],
  });

  const before = available(world.inventory);
  assert.equal(world.inventory.onHand, 10);
  assert.equal(world.inventory.reserved, 3);

  releaseOrder(world.inventory, ORDER_READY, world.orders.get(ORDER_READY)!.lines, QA_CLEANUP_REASON);

  assert.equal(world.inventory.onHand, world.initial.onHand, 'on_hand queda intacto');
  assert.equal(world.inventory.reserved, 0, 'reserved baja según lo liberado');
  assert.equal(available(world.inventory), before + 3, 'available sube de forma consistente');

  const movement = world.inventory.movements.at(-1)!;
  assert.equal(movement.movementType, 'reservation_release');
  assert.equal(movement.onHandDelta, 0, 'cancelar nunca descuenta on_hand');
  assert.equal(movement.reservedDelta, -3);
  assert.equal(movement.reason, QA_CLEANUP_REASON, 'el ledger queda auditado con el motivo');
});

test('el ledger y el historial se conservan: liberar agrega, nunca borra', () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 2,
    orders: [{ id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 2 }],
  });

  const movementsBefore = world.inventory.movements.length;
  const reservationKeys = world.inventory.movements.map((m) => m.idempotencyKey);

  releaseOrder(world.inventory, ORDER_READY, world.orders.get(ORDER_READY)!.lines, QA_CLEANUP_REASON);
  releaseOrder(world.inventory, ORDER_READY, world.orders.get(ORDER_READY)!.lines, QA_CLEANUP_REASON);

  assert.equal(world.inventory.movements.length, movementsBefore + 1, 'un solo movimiento nuevo');
  for (const key of reservationKeys) {
    assert.ok(
      world.inventory.movements.some((m) => m.idempotencyKey === key),
      `la reserva ${key} sigue en el ledger`,
    );
  }
});

// =============================================================================
//  5. PIN — un pedido cancelado no puede entregarse
// =============================================================================

test('cancelar revoca el PIN emitido y el canje posterior NO compromete stock', async () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 1,
    orders: [{ id: ORDER_READY, orderNumber: 'QA-3', status: 'ready_for_pickup', quantity: 1 }],
    pickups: [{ code: '482913', orderId: ORDER_READY, status: 'issued' }],
  });
  const fake = makeFakeCleanup(world);
  const line = world.orders.get(ORDER_READY)!.lines;

  await runQaOrderCleanup([ORDER_READY], {
    loadOrder: loadOrderFrom(world),
    cancelForQa: fake.cancelForQa,
  });

  assert.equal(world.pickups[0].status, 'revoked', 'el PIN queda revocado en la base');

  const stockBefore = world.inventory;
  const snapshot = { onHand: stockBefore.onHand, reserved: stockBefore.reserved, movements: stockBefore.movements.length };

  // Intento de retiro con el PIN del pedido cancelado.
  const redeem = redeemPickupCodeModel('482913', world.pickups, world.inventory, ORDER_READY, line, NOW);

  assert.equal(redeem.ok, false);
  assert.equal(redeem.error_code, 'pickup_code_expired', 'se rechaza como PIN vencido, no como fallo interno');
  assert.equal(redeem.committed_lines, 0, 'no se hace `sale` de inventario');
  assert.equal(redeem.aborted, false, 'no hay error interno (nada de reserved negativo)');

  assert.equal(world.inventory.onHand, snapshot.onHand);
  assert.equal(world.inventory.reserved, snapshot.reserved);
  assert.equal(world.inventory.movements.length, snapshot.movements, 'no aparecen movimientos');
});

test('sin revocar el PIN, el canje sí intentaría comprometer stock (por eso se revoca)', () => {
  // Escenario "hueco": pedido cancelado y reserva liberada, pero PIN todavía `issued`.
  const world = makeWorld({
    onHand: 10,
    reserved: 1,
    orders: [{ id: ORDER_READY, orderNumber: 'QA-3', status: 'cancelled', quantity: 1 }],
    pickups: [{ code: '482913', orderId: ORDER_READY, status: 'issued' }],
  });
  const line = world.orders.get(ORDER_READY)!.lines;

  releaseOrder(world.inventory, ORDER_READY, line, QA_CLEANUP_REASON);
  assert.equal(world.inventory.reserved, 0);

  const redeem = redeemPickupCodeModel('482913', world.pickups, world.inventory, ORDER_READY, line, NOW);

  // El commit choca con el CHECK `reserved >= 0`: se aborta y se revierte el canje.
  assert.equal(redeem.ok, false);
  assert.equal(redeem.aborted, true);
  assert.equal(redeem.committed_lines, 0);
  assert.equal(world.inventory.reserved, 0, 'el rollback deja el inventario coherente');
  assert.equal(world.pickups[0].status, 'issued', 'el canje se revirtió completo');
});

test('un PIN ya revocado se rechaza antes de intentar cualquier commit', () => {
  const world = makeWorld({
    onHand: 10,
    reserved: 0,
    orders: [{ id: ORDER_READY, orderNumber: 'QA-3', status: 'cancelled', quantity: 1 }],
    pickups: [{ code: '482913', orderId: ORDER_READY, status: 'revoked' }],
  });

  const redeem = redeemPickupCodeModel(
    '482913',
    world.pickups,
    world.inventory,
    ORDER_READY,
    world.orders.get(ORDER_READY)!.lines,
    NOW,
  );

  assert.equal(redeem.ok, false);
  assert.equal(redeem.error_code, 'pickup_code_expired');
  assert.equal(redeem.committed_lines, 0);
  assert.equal(redeem.aborted, false);
});

// =============================================================================
//  6. LISTADO ADMIN — read-only y REDACTADO
// =============================================================================

const PUBLIC_TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_REF = 'SIMULATED-MP-123';

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_READY,
    order_number: 'QA-3',
    public_token: PUBLIC_TOKEN,
    idempotency_key: 'idem-secret',
    customer_id: null,
    contact_email: 'qa@testuser.com',
    contact_phone: '+51900000000',
    channel: 'web',
    fulfillment_type: 'pickup_locker',
    locker_code: null,
    status: 'ready_for_pickup',
    payment_status: 'paid',
    payment_method: 'simulation_qa',
    payment_reference: PAYMENT_REF,
    currency: 'PEN',
    subtotal: '749',
    discount_total: '0',
    tax_total: '0',
    shipping_total: '0',
    total: '749',
    item_count: 1,
    shipping_address: null,
    pickup_instructions: null,
    customer_note: null,
    reservation_expires_at: null,
    reservation_released: false,
    confirmed_at: '2026-10-08T12:00:00.000Z',
    ready_at: '2026-10-08T12:10:00.000Z',
    picked_up_at: null,
    delivered_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    metadata: {
      buyer: { fullName: 'QA Omar', docNumber: '12345678' },
      payment: { stockConflict: false, needsReview: true, lastPaymentId: PAYMENT_REF },
    },
    version: 2,
    created_at: '2026-10-08T11:59:00.000Z',
    updated_at: '2026-10-08T12:10:00.000Z',
    ...overrides,
  };
}

function itemRow(): OrderItemRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    order_id: ORDER_READY,
    line_number: 1,
    product_slug: 'dyson-v15-detect',
    product_name: 'Dyson V15 Detect Absolute',
    product_brand: 'Dyson',
    image_url: null,
    variant_key: '',
    variant: {},
    quantity: 1,
    unit_price: '749',
    discount_amount: '0',
    tax_amount: '0',
    line_total: '749',
    created_at: '2026-10-08T11:59:00.000Z',
    updated_at: '2026-10-08T11:59:00.000Z',
  };
}

const PIN = '482913';

function pickupRow(overrides: Partial<PickupCodeRow> = {}): PickupCodeRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    order_id: ORDER_READY,
    code: PIN,
    locker_code: 'LOCKER-A',
    locker_slot: '12',
    status: 'issued',
    max_attempts: 5,
    attempts: 0,
    expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
    redeemed_at: null,
    redeemed_by: null,
    revoked_at: null,
    revocation_reason: null,
    created_at: '2026-10-08T12:10:00.000Z',
    updated_at: '2026-10-08T12:10:00.000Z',
    ...overrides,
  };
}

test('vista admin: expone lo que se necesita y NUNCA el token público ni el PIN', () => {
  const view = toAdminOrderView(orderRow(), [itemRow()], [pickupRow()], new Date(NOW));

  assert.equal(view.orderId, ORDER_READY);
  assert.equal(view.orderNumber, 'QA-3');
  assert.equal(view.status, 'ready_for_pickup');
  assert.equal(view.paymentStatus, 'paid');
  assert.equal(view.fulfillmentType, 'pickup_locker');
  assert.equal(view.customerName, 'QA Omar');
  assert.equal(view.contactEmail, 'qa@testuser.com');
  assert.equal(view.createdAt, '2026-10-08T11:59:00.000Z');
  assert.equal(view.reservationReleased, false);
  assert.equal(view.needsReview, true, 'se deriva del audit de pago');
  assert.equal(view.stockConflict, false);
  assert.equal(view.items.length, 1);
  assert.deepEqual(view.items[0], {
    productSlug: 'dyson-v15-detect',
    productName: 'Dyson V15 Detect Absolute',
    variantKey: '',
    quantity: 1,
    unitPrice: 749,
    lineTotal: 749,
  });
  assert.equal(view.hasActivePickupCode, true);
  assert.equal(view.pickupCode?.isActive, true);

  // Redacción: nada de esto puede salir por un endpoint.
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(PUBLIC_TOKEN), 'no filtra el token público');
  assert.ok(!serialized.includes(PIN), 'no filtra el PIN');
  assert.ok(!serialized.includes(PAYMENT_REF), 'no filtra la referencia de pago');
  assert.ok(!serialized.includes('12345678'), 'no filtra el documento del comprador');
  assert.ok(!('publicToken' in view));
  assert.ok(!('paymentReference' in view));
  assert.ok(!('idempotencyKey' in view));
  assert.ok(!('metadata' in view));
  assert.ok(view.pickupCode && !('code' in view.pickupCode), 'nunca incluye el código del PIN');
});

test('vista admin: un PIN revocado deja de contar como activo', () => {
  const revoked = pickupRow({ status: 'revoked', revoked_at: '2026-10-08T12:30:00.000Z', revocation_reason: QA_CLEANUP_REASON });
  const view = toAdminOrderView(orderRow({ status: 'cancelled' }), [itemRow()], [revoked], new Date(NOW));

  assert.equal(view.status, 'cancelled');
  assert.equal(view.hasActivePickupCode, false);
  assert.equal(view.pickupCode?.status, 'revoked');
  assert.equal(view.pickupCode?.revocationReason, QA_CLEANUP_REASON);
});

test('vista admin: un PIN vencido pero todavía `issued` no es activo', () => {
  const expired = pickupRow({ expires_at: new Date(NOW - 1000).toISOString() });
  const view: AdminOrderView = toAdminOrderView(orderRow(), [itemRow()], [expired], new Date(NOW));

  assert.equal(view.pickupCode?.isExpired, true);
  assert.equal(view.hasActivePickupCode, false);
});

test('vista admin: sin PINs, el pedido igual se lista', () => {
  const view = toAdminOrderView(orderRow(), [itemRow()], [], new Date(NOW));
  assert.equal(view.pickupCode, null);
  assert.equal(view.hasActivePickupCode, false);
});

// =============================================================================
//  7. RESERVA VIVA — auditoría READ-ONLY del ledger
//
//  La autoridad de "qué pedido retiene stock" es `inventory_movements`, no el estado.
//  Acá se cubre el predicado puro y el redactado de la vista de reservas; el SQL que lo
//  alimenta se ejecuta contra Postgres en tiempo de petición (no hay Postgres en tests).
// =============================================================================

function movement(overrides: Partial<AdminInventoryMovementView> = {}): AdminInventoryMovementView {
  return {
    id: '1',
    movementType: 'reservation',
    onHandDelta: 0,
    reservedDelta: 1,
    onHandAfter: 5,
    reservedAfter: 1,
    reason: 'order reservation',
    performedBy: 'system',
    createdAt: '2026-10-08T11:59:00.000Z',
    ...overrides,
  };
}

test('reserva viva: sólo cuenta con `reservation` y SIN `reservation_release`/`sale`', () => {
  assert.equal(isActivelyReservedLine({ hasReservation: true, hasReleaseOrSale: false }), true);
  assert.equal(isActivelyReservedLine({ hasReservation: true, hasReleaseOrSale: true }), false);
  assert.equal(isActivelyReservedLine({ hasReservation: false, hasReleaseOrSale: false }), false);
  assert.equal(isActivelyReservedLine({ hasReservation: false, hasReleaseOrSale: true }), false);
});

test('vista de reservas: identifica el pedido que retiene, su línea y sus movimientos', () => {
  const order = orderRow({
    status: 'pending_payment',
    payment_status: 'pending',
    reservation_expires_at: '2026-10-08T12:30:00.000Z',
    reservation_released: false,
    confirmed_at: null,
    ready_at: null,
  });

  const liveLine: AdminReservationLineInput = {
    item: itemRow(),
    hasReservation: true,
    hasReleaseOrSale: false,
    movements: [movement()],
  };
  // Segunda línea del mismo pedido: ya liberada (no debe contar como retención viva).
  const releasedLine: AdminReservationLineInput = {
    item: { ...itemRow(), id: '66666666-6666-4666-8666-666666666666' },
    hasReservation: true,
    hasReleaseOrSale: true,
    movements: [
      movement(),
      movement({ id: '2', movementType: 'reservation_release', reservedDelta: -1, reason: 'qa_cleanup' }),
    ],
  };

  const view = toAdminReservationHolderView(order, [liveLine, releasedLine], [pickupRow()], new Date(NOW));

  assert.equal(view.orderId, ORDER_READY);
  assert.equal(view.orderNumber, 'QA-3');
  assert.equal(view.status, 'pending_payment', 'el estado real se conserva (no se normaliza)');
  assert.equal(view.paymentStatus, 'pending');
  assert.equal(view.createdAt, '2026-10-08T11:59:00.000Z');
  assert.equal(view.reservationReleased, false);
  assert.equal(view.reservationExpiresAt, '2026-10-08T12:30:00.000Z');

  assert.equal(view.reservationLines.length, 1, 'sólo la línea con reserva viva');
  assert.equal(view.reservationLines[0].productSlug, 'dyson-v15-detect');
  assert.equal(view.reservationLines[0].variantKey, '');
  assert.equal(view.reservationLines[0].quantity, 1);
  assert.equal(view.reservedUnits, 1);
  assert.equal(view.reservationLines[0].movements[0].movementType, 'reservation');

  // `items` es la vista base completa: las dos líneas siguen visibles.
  assert.equal(view.items.length, 2);

  // Redacción: la vista de reservas hereda la lista blanca.
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(PUBLIC_TOKEN), 'no filtra el token público');
  assert.ok(!serialized.includes(PIN), 'no filtra el PIN');
  assert.ok(!serialized.includes(PAYMENT_REF), 'no filtra la referencia de pago');
  assert.ok(!serialized.includes('12345678'), 'no filtra el documento del comprador');
});

test('filtro reservationActive: sólo "1" enciende la auditoría (cualquier otro valor → 400)', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    for (const value of ['0', 'true', 'yes', '2']) {
      const response = await listOrdersRoute(
        new NextRequest(`http://localhost/api/admin/orders?reservationActive=${value}`, {
          headers: { 'x-admin-token': ADMIN_SECRET },
        }) as unknown as ListRequest,
      );
      assert.equal(response.status, 400, `valor rechazado: ${value}`);
      assert.equal((await response.json()).code, 'invalid_reservation_active');
    }
  });
});

test('filtro reservationActive: exige token (401) y no acepta status (400)', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    const noToken = await listOrdersRoute(
      new NextRequest('http://localhost/api/admin/orders?reservationActive=1') as unknown as ListRequest,
    );
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).code, 'admin_unauthorized');

    const withStatus = await listOrdersRoute(
      new NextRequest('http://localhost/api/admin/orders?reservationActive=1&status=confirmed', {
        headers: { 'x-admin-token': ADMIN_SECRET },
      }) as unknown as ListRequest,
    );
    assert.equal(withStatus.status, 400);
    assert.equal((await withStatus.json()).code, 'invalid_filter');
  });
});

test('filtro reservationActive: limit fuera de rango se rechaza (400) antes de tocar la base', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    const response = await listOrdersRoute(
      new NextRequest('http://localhost/api/admin/orders?reservationActive=1&limit=999', {
        headers: { 'x-admin-token': ADMIN_SECRET },
      }) as unknown as ListRequest,
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_limit');
  });
});
