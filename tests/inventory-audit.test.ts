// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET as movementsRoute } from '../app/api/admin/inventory/movements/route';
import {
  classifyReservationLines,
  latestLifecycleMovement,
  reconcileReservedDeltas,
  sortMovementsChronologically,
  type InventoryMovementAudit,
} from '../lib/inventory-audit';

/**
 * Auditoría READ-ONLY del ledger (`inventory_movements`) vs `inventory`.
 *
 * ⚠️ LIMITACIÓN (igual que el resto de las suites de comercio): no hay Postgres en los
 * tests. La query vive en `lib/commerce.server.ts`; acá se prueba la SEMÁNTICA pura que
 * decide si una línea retiene stock y dónde diverge el ledger, más los candados de la
 * ruta (`x-admin-token`, parámetros).
 */

const ADMIN_SECRET = 'test-admin-secret-0123456789';

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

type MovementsRequest = Parameters<typeof movementsRoute>[0];

let seq = 0;
function mv(overrides: Partial<InventoryMovementAudit> = {}): InventoryMovementAudit {
  seq += 1;
  return {
    id: String(seq),
    orderId: null,
    orderItemId: null,
    movementType: 'reservation',
    onHandDelta: 0,
    reservedDelta: 0,
    onHandAfter: 5,
    reservedAfter: 0,
    idempotencyKey: null,
    reason: null,
    performedBy: 'system',
    createdAt: `2026-10-08T12:00:${String(seq).padStart(2, '0')}.000Z`,
    variantKey: '',
    ...overrides,
  };
}

// =============================================================================
//  1. ORDEN CRONOLÓGICO
// =============================================================================

test('orden cronológico: por created_at y, a igualdad, por id del ledger', () => {
  const a = mv({ id: '2', createdAt: '2026-10-08T12:00:01.000Z' });
  const b = mv({ id: '10', createdAt: '2026-10-08T12:00:00.000Z' });
  const c = mv({ id: '1', createdAt: '2026-10-08T12:00:01.000Z' });

  assert.deepEqual(
    sortMovementsChronologically([a, b, c]).map((m) => m.id),
    ['10', '1', '2'],
  );
});

// =============================================================================
//  2. LIVENESS — el ÚLTIMO movimiento del ciclo decide (igual que inventory_rereserve_order)
// =============================================================================

test('liveness: reserva → libre → re-reservada vuelve a estar VIVA', () => {
  const lifecycle = (types: string[]) =>
    latestLifecycleMovement(
      types.map((type, index) =>
        mv({ movementType: type, id: String(index + 1), createdAt: `2026-10-08T12:00:0${index}.000Z` }),
      ),
    );

  assert.equal(lifecycle(['reservation']), 'reservation');
  assert.equal(lifecycle(['reservation', 'reservation_release']), 'reservation_release');
  assert.equal(lifecycle(['reservation', 'sale']), 'sale');
  assert.equal(
    lifecycle(['reservation', 'reservation_release', 'reservation']),
    'reservation',
    'una re-reserva (pago tardío) vuelve a retener stock',
  );
  assert.equal(lifecycle([]), null);
  assert.equal(lifecycle(['receipt', 'adjustment']), null, 'los movimientos fuera del ciclo no cuentan');
});

// =============================================================================
//  3. RECONCILIACIÓN reserved_delta vs inventory.quantity_reserved
// =============================================================================

test('reconciliación: el ledger cuadra con inventory (sin divergencia)', () => {
  const movements = [
    mv({ id: '1', movementType: 'reservation', reservedDelta: 1, reservedAfter: 1, createdAt: '2026-10-08T12:00:01.000Z' }),
    mv({ id: '2', movementType: 'reservation_release', reservedDelta: -1, reservedAfter: 0, createdAt: '2026-10-08T12:00:02.000Z' }),
    mv({ id: '3', movementType: 'reservation', reservedDelta: 1, reservedAfter: 1, createdAt: '2026-10-08T12:00:03.000Z' }),
  ];

  const rec = reconcileReservedDeltas(movements, 1, '');

  assert.equal(rec.movementCount, 3);
  assert.equal(rec.reservedLedgerSum, 1);
  assert.equal(rec.ledgerFinalReserved, 1);
  assert.equal(rec.inventoryReserved, 1);
  assert.equal(rec.matchesInventory, true);
  assert.equal(rec.firstDivergence, null);
});

test('reconciliación: si inventory se desincroniza del ledger, señala el primer punto', () => {
  const movements = [
    mv({ id: '1', movementType: 'reservation', reservedDelta: 1, reservedAfter: 1, createdAt: '2026-10-08T12:00:01.000Z' }),
    // `reserved_after = 1` cuando la suma corrida ya es 0 → hubo escritura fuera del motor.
    mv({ id: '2', movementType: 'reservation_release', reservedDelta: -1, reservedAfter: 1, createdAt: '2026-10-08T12:00:02.000Z' }),
  ];

  const rec = reconcileReservedDeltas(movements, 1, '');

  assert.equal(rec.reservedLedgerSum, 0);
  assert.equal(rec.ledgerFinalReserved, 1);
  assert.equal(rec.matchesInventory, false);
  assert.equal(rec.firstDivergence?.movementId, '2');
  assert.equal(rec.firstDivergence?.reservedRunningTotal, 0);
  assert.equal(rec.firstDivergence?.reservedAfter, 1);
});

// =============================================================================
//  4. CLASIFICACIÓN POR LÍNEA
// =============================================================================

test('clasificación: una re-reserva queda viva; una vendida no; sin item va a unattributed', () => {
  const itemA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const itemB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

  const movements = [
    mv({ id: '1', orderItemId: itemA, orderId: 'oa', movementType: 'reservation', reservedDelta: 1, reservedAfter: 1, createdAt: '2026-10-08T12:00:01.000Z' }),
    mv({ id: '2', orderItemId: itemA, orderId: 'oa', movementType: 'reservation_release', reservedDelta: -1, reservedAfter: 0, createdAt: '2026-10-08T12:00:02.000Z' }),
    mv({ id: '3', orderItemId: itemA, orderId: 'oa', movementType: 'reservation', reservedDelta: 1, reservedAfter: 1, createdAt: '2026-10-08T12:00:03.000Z' }),
    mv({ id: '4', orderItemId: itemB, orderId: 'ob', movementType: 'reservation', reservedDelta: 1, reservedAfter: 2, createdAt: '2026-10-08T12:00:04.000Z' }),
    mv({ id: '5', orderItemId: itemB, orderId: 'ob', movementType: 'sale', reservedDelta: -1, reservedAfter: 1, createdAt: '2026-10-08T12:00:05.000Z' }),
    mv({ id: '6', orderItemId: null, orderId: null, movementType: 'adjustment', reservedDelta: 1, reservedAfter: 2, createdAt: '2026-10-08T12:00:06.000Z' }),
  ];

  const { lines, unattributed } = classifyReservationLines(movements);

  const a = lines.find((line) => line.orderItemId === itemA);
  const b = lines.find((line) => line.orderItemId === itemB);

  assert.equal(a?.latestMovement, 'reservation');
  assert.equal(a?.heldUnits, 1);
  assert.equal(a?.orderId, 'oa');
  assert.equal(b?.latestMovement, 'sale');
  assert.equal(b?.heldUnits, 0);
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0].orderItemId, null);
});

// =============================================================================
//  5. RUTA — read-only y candados
// =============================================================================

test('ruta movements: exige x-admin-token (401)', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    const response = await movementsRoute(
      new NextRequest(
        'http://localhost/api/admin/inventory/movements?product=dyson-v15-detect',
      ) as unknown as MovementsRequest,
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'admin_unauthorized');
  });
});

test('ruta movements: product obligatorio (400) y limit validado (400), sin tocar la base', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    const missing = await movementsRoute(
      new NextRequest('http://localhost/api/admin/inventory/movements', {
        headers: { 'x-admin-token': ADMIN_SECRET },
      }) as unknown as MovementsRequest,
    );
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'missing_product');

    const badLimit = await movementsRoute(
      new NextRequest(
        'http://localhost/api/admin/inventory/movements?product=dyson-v15-detect&limit=99999',
        { headers: { 'x-admin-token': ADMIN_SECRET } },
      ) as unknown as MovementsRequest,
    );
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).code, 'invalid_limit');
  });
});
