import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMovement,
  available,
  commitOrder,
  hasLiveReservation,
  newInventory,
  releaseOrder,
  type OrderLine,
} from './helpers/qa-cleanup-model';

/**
 * Ciclo de vida de `inventory_release_order()` (migración 007) — MODELO DE REFERENCIA.
 *
 * ⚠️ LIMITACIÓN (igual que el resto de las suites de comercio): no hay Postgres en
 * `node --test`, así que estas pruebas ejercen el MODELO de `tests/helpers/qa-cleanup-model.ts`,
 * que espeja la semántica del SQL. La autoridad sigue siendo `inventory_release_order()`
 * (007). El caso que protegen es el real de Preview (UM-2026-001017): una línea
 * `reservation → reservation_release → reservation` quedaba sin liberar.
 */

const ORDER = 'order-1';
const LINE: OrderLine = { orderItemId: 'item-1', quantity: 1 };

/** Reserva inicial del checkout (misma clave que `inventory_reserve_order`). */
function reserve(state: ReturnType<typeof newInventory>, orderItemId = LINE.orderItemId) {
  applyMovement(state, {
    movementType: 'reservation',
    reservedDelta: 1,
    orderId: ORDER,
    orderItemId,
    idempotencyKey: `reserve:${ORDER}:${orderItemId}`,
    reason: 'order reservation',
  });
}

/** Re-reserva por pago tardío (`inventory_rereserve_order`). */
function rereserve(state: ReturnType<typeof newInventory>, orderItemId = LINE.orderItemId) {
  applyMovement(state, {
    movementType: 'reservation',
    reservedDelta: 1,
    orderId: ORDER,
    orderItemId,
    idempotencyKey: `rereserve:${ORDER}:${orderItemId}`,
    reason: 'late payment re-reservation',
  });
}

// =============================================================================
//  A) reservation → release → reservation → release ⇒ reserved final 0
// =============================================================================

test('A: reserva → libera → re-reserva → libera ⇒ reserved final 0', () => {
  const state = newInventory(5, 0);

  reserve(state);
  assert.equal(state.reserved, 1);

  assert.equal(releaseOrder(state, ORDER, [LINE]).releasedLines, 1);
  assert.equal(state.reserved, 0);

  rereserve(state);
  assert.equal(state.reserved, 1);
  assert.equal(hasLiveReservation(state, LINE.orderItemId), true, 'la re-reserva vuelve a estar viva');

  const second = releaseOrder(state, ORDER, [LINE]);

  assert.equal(second.releasedLines, 1, 'una re-reserva SÍ se libera');
  assert.equal(state.reserved, 0);
  assert.equal(state.onHand, 5, 'liberar nunca toca on_hand');

  const releases = state.movements.filter((m) => m.movementType === 'reservation_release');
  assert.equal(releases.length, 2);
  assert.equal(releases[0].idempotencyKey, `release:${ORDER}:${LINE.orderItemId}`, 'la 1ª conserva la clave histórica');
  assert.equal(
    releases[1].idempotencyKey,
    `release:${ORDER}:${LINE.orderItemId}:2`,
    'la 2ª usa una clave NUEVA para que el delta se aplique',
  );
});

// =============================================================================
//  B) reservation → release → segundo release ⇒ no-op
// =============================================================================

test('B: un segundo release sin re-reserva es no-op', () => {
  const state = newInventory(5, 0);

  reserve(state);
  assert.equal(releaseOrder(state, ORDER, [LINE]).releasedLines, 1);

  const movementsAfterFirst = state.movements.length;
  const second = releaseOrder(state, ORDER, [LINE]);

  assert.equal(second.releasedLines, 0);
  assert.equal(state.movements.length, movementsAfterFirst, 'no agrega movimientos');
  assert.equal(state.reserved, 0);
});

// =============================================================================
//  C) reservation → sale → release ⇒ nada
// =============================================================================

test('C: si la línea ya se vendió, release no toca nada', () => {
  const state = newInventory(5, 0);

  reserve(state);
  commitOrder(state, ORDER, [LINE]);
  assert.equal(state.onHand, 4);
  assert.equal(state.reserved, 0);

  const movementsBefore = state.movements.length;
  const release = releaseOrder(state, ORDER, [LINE]);

  assert.equal(release.releasedLines, 0);
  assert.equal(state.movements.length, movementsBefore);
  assert.equal(state.onHand, 4, 'release nunca toca on_hand');
  assert.equal(state.reserved, 0);
});

// =============================================================================
//  D) dos order_items independientes
// =============================================================================

test('D: liberar una línea no toca a la otra', () => {
  const state = newInventory(5, 0);
  const a: OrderLine = { orderItemId: 'item-a', quantity: 1 };
  const b: OrderLine = { orderItemId: 'item-b', quantity: 1 };

  reserve(state, a.orderItemId);
  reserve(state, b.orderItemId);
  assert.equal(state.reserved, 2);

  const release = releaseOrder(state, ORDER, [a]);

  assert.equal(release.releasedLines, 1);
  assert.equal(state.reserved, 1);
  assert.equal(hasLiveReservation(state, a.orderItemId), false);
  assert.equal(hasLiveReservation(state, b.orderItemId), true, 'la otra línea sigue retenida');
});

// =============================================================================
//  E) cancelar una re-reserva: on_hand igual, reserved baja, available sube, flag true
// =============================================================================

test('E: cancelar una re-reserva ⇒ on_hand igual, reserved baja, available sube, reservationReleased=true', () => {
  const state = newInventory(5, 0);

  reserve(state);
  releaseOrder(state, ORDER, [LINE]); // liberada (p. ej. por TTL / reaper)
  rereserve(state);

  const onHandBefore = state.onHand;
  const availableBefore = available(state); // 5 - 1 = 4
  assert.equal(availableBefore, 4);

  const cancel = releaseOrder(state, ORDER, [LINE]);

  assert.equal(cancel.releasedLines, 1);
  assert.equal(cancel.orderReservationReleased, true);
  assert.equal(state.onHand, onHandBefore, 'on_hand no cambia');
  assert.equal(state.reserved, 0, 'reserved baja');
  assert.equal(available(state), availableBefore + 1, 'available sube');
});
