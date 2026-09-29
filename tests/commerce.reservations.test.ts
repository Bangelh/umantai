import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateOrderPayability } from '../lib/commerce';
import { isDeadlockError, withDeadlockRetry } from '../lib/commerce.server';

/**
 * Pruebas de la expiración de reservas y del único reintento permitido.
 *
 * No tocan la base de datos: el motor real es PL/pgSQL
 * (`expire_stale_orders` / `inventory_release_order`) y aquí se prueban las dos
 * decisiones que SÍ viven en JavaScript:
 *   1. cuándo se considera que una reserva venció (`evaluateOrderPayability`);
 *   2. cuándo se reintenta un deadlock (`40P01`) y cuándo no.
 */

/** Error sintético con SQLSTATE, igual que lo entrega el driver de Neon. */
function dbError(code: string, message = ''): Error & { code: string } {
  return Object.assign(new Error(message || `pg error ${code}`), { code });
}

// =============================================================================
//  Clasificación y reintento de 40P01
// =============================================================================

test('isDeadlockError: reconoce 40P01 por SQLSTATE y por mensaje, y rechaza el resto', () => {
  assert.equal(isDeadlockError(dbError('40P01')), true);
  assert.equal(isDeadlockError(dbError('40P01', 'deadlock detected')), true);
  assert.equal(isDeadlockError(new Error('deadlock detected')), true);

  // Nada más se reintenta: un choque de unicidad es idempotencia (no un deadlock) y
  // un `insufficient_stock` reintentado sería una forma silenciosa de sobreventa.
  assert.equal(isDeadlockError(dbError('23505')), false);
  assert.equal(isDeadlockError(dbError('23514', 'insufficient_stock')), false);
  assert.equal(isDeadlockError(new Error('insufficient_stock')), false);
  assert.equal(isDeadlockError(null), false);
  assert.equal(isDeadlockError(undefined), false);
});

test('withDeadlockRetry: reintenta un deadlock una vez y devuelve el resultado', async () => {
  let calls = 0;

  const result = await withDeadlockRetry('test:retry-once', async () => {
    calls += 1;
    if (calls === 1) throw dbError('40P01');
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withDeadlockRetry: no reintenta un error que no sea deadlock', async () => {
  let calls = 0;

  await assert.rejects(
    withDeadlockRetry('test:no-retry', async () => {
      calls += 1;
      throw dbError('23514', 'insufficient_stock');
    }),
    /insufficient_stock/,
  );

  // Un solo intento: el error sube tal cual a la ruta, que lo traduce a 409.
  assert.equal(calls, 1);
});

test('withDeadlockRetry: se rinde tras UN reintento y propaga el deadlock', async () => {
  let calls = 0;

  await assert.rejects(
    withDeadlockRetry('test:gives-up', async () => {
      calls += 1;
      throw dbError('40P01');
    }),
    (error: unknown) => isDeadlockError(error),
  );

  // El retry es acotado (1 intento + 1 reintento): no es un bucle que esconda un
  // deadlock recurrente.
  assert.equal(calls, 2);
});

test('concurrencia simulada: dos checkouts que se deadlockean una vez terminan ambos bien', async () => {
  // Modela el escenario real: dos carritos que toman las filas de `inventory` en
  // orden opuesto. Postgres mata a uno con 40P01 y el perdedor reintenta; ninguno
  // debe propagar el error al comprador.
  const runCheckout = (id: string) => {
    let attempt = 0;
    return withDeadlockRetry(`createOrder:${id}`, async () => {
      attempt += 1;
      if (attempt === 1) throw dbError('40P01', 'deadlock detected');
      return `${id}:ok`;
    });
  };

  const results = await Promise.all([runCheckout('A'), runCheckout('B')]);
  assert.deepEqual(results.sort(), ['A:ok', 'B:ok']);
});

// =============================================================================
//  Regla de vencimiento (el reloj con el que se decide "expirado")
// =============================================================================

test('evaluateOrderPayability: una reserva vencida no es pagable y una viva sí', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  assert.equal(
    evaluateOrderPayability(
      { status: 'pending_payment', reservationExpiresAt: '2026-09-28T11:59:59Z' },
      now,
    ),
    'reservation_expired',
  );

  assert.equal(
    evaluateOrderPayability(
      { status: 'pending_payment', reservationExpiresAt: '2026-09-28T12:00:01Z' },
      now,
    ),
    'payable',
  );

  // En el borde exacto la lectura ya la da por vencida (`<=`), mientras que el reaper
  // usa `<` en Postgres: en ese instante la API dice "vencida" pero el barrido todavía
  // no libera. Es una diferencia de un tick y siempre en el sentido seguro.
  assert.equal(
    evaluateOrderPayability(
      { status: 'pending_payment', reservationExpiresAt: '2026-09-28T12:00:00Z' },
      now,
    ),
    'reservation_expired',
  );
});

test('evaluateOrderPayability: fuera de `pending_payment` no es pagable por otra razón', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  // Un pedido que el reaper ya expiró (o cualquier otro estado) no se cobra: la ruta
  // de preferencia responde `order_not_payable`, no `reservation_expired`.
  assert.equal(
    evaluateOrderPayability(
      { status: 'expired', reservationExpiresAt: '2026-09-28T11:00:00Z' },
      now,
    ),
    'order_not_payable',
  );
  assert.equal(
    evaluateOrderPayability({ status: 'confirmed', reservationExpiresAt: null }, now),
    'order_not_payable',
  );
  assert.equal(
    evaluateOrderPayability({ status: 'cancelled', reservationExpiresAt: null }, now),
    'order_not_payable',
  );

  // Sin fecha legible no se bloquea la venta por un dato raro.
  assert.equal(
    evaluateOrderPayability(
      { status: 'pending_payment', reservationExpiresAt: 'no-es-una-fecha' },
      now,
    ),
    'payable',
  );
});
