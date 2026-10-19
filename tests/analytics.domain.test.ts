/**
 * tests/analytics.domain.test.ts — reglas puras del dashboard.
 *
 * Lo que se prueba acá es justamente lo que no puede quedar "aproximado":
 * qué pedido es venta, cómo se corta el día comercial de Lima y cómo se
 * convierten los montos NUMERIC a centavos enteros.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANALYTICS_MAX_RANGE_DAYS,
  addDays,
  averageTicketCents,
  describeVariantKey,
  fillSeries,
  isSaleOrder,
  isValidLocalDate,
  isoWeekday,
  listDays,
  listIsoWeeks,
  percentChange,
  resolveAnalyticsRange,
  startOfIsoWeek,
  toCents,
  todayInTimeZone,
  zonedDateTimeToUtc,
} from '../lib/analytics';

// =============================================================================
//  REGLA DE VENTA
// =============================================================================

test('regla de venta: pendientes, cancelados, expirados y reembolsados NO cuentan', () => {
  assert.equal(isSaleOrder('pending_payment', 'paid'), false);
  assert.equal(isSaleOrder('cancelled', 'paid'), false);
  assert.equal(isSaleOrder('expired', 'paid'), false);
  assert.equal(isSaleOrder('refunded', 'paid'), false);
});

test('regla de venta: confirmado o posterior con pago cobrado SÍ cuenta', () => {
  assert.equal(isSaleOrder('confirmed', 'paid'), true);
  assert.equal(isSaleOrder('preparing', 'paid'), true);
  assert.equal(isSaleOrder('ready_for_pickup', 'paid'), true);
  assert.equal(isSaleOrder('picked_up', 'paid'), true);
  assert.equal(isSaleOrder('out_for_delivery', 'paid'), true);
  assert.equal(isSaleOrder('delivered', 'paid'), true);
  assert.equal(isSaleOrder('completed', 'paid'), true);
  assert.equal(isSaleOrder('completed', 'partially_refunded'), true);
});

test('regla de venta: un estado bueno con pago fallido/authorized/pending NO cuenta', () => {
  assert.equal(isSaleOrder('confirmed', 'pending'), false);
  assert.equal(isSaleOrder('confirmed', 'failed'), false);
  assert.equal(isSaleOrder('confirmed', 'authorized'), false);
  assert.equal(isSaleOrder('completed', 'refunded'), false);
});

// =============================================================================
//  DINERO
// =============================================================================

test('toCents convierte NUMERIC string a enteros, sin floats', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents('0.10'), 10);
  assert.equal(toCents('0'), 0);
  assert.equal(toCents(null), 0);
  assert.equal(toCents(undefined), 0);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('no-es-numero'), 0);
  assert.equal(toCents('1299.99'), 129999);

  // La suma de centavos es exacta (0.1 + 0.2 no lo sería en float).
  assert.equal(toCents('0.10') + toCents('0.20'), 30);
});

test('ticket promedio se calcula sobre enteros y nunca es NaN', () => {
  assert.equal(averageTicketCents(10_000, 3), 3333);
  assert.equal(averageTicketCents(0, 0), 0);
  assert.equal(averageTicketCents(1000, 0), 0);
});

test('variación porcentual: null cuando no hay base', () => {
  assert.equal(percentChange(120, 100), 20);
  assert.equal(percentChange(80, 100), -20);
  assert.equal(percentChange(100, 0), null);
  assert.equal(percentChange(0, 0), null);
});

// =============================================================================
//  CALENDARIO / ZONA HORARIA
// =============================================================================

test('fechas locales: valida el calendario real, no solo el formato', () => {
  assert.equal(isValidLocalDate('2026-10-19'), true);
  assert.equal(isValidLocalDate('2024-02-29'), true);
  assert.equal(isValidLocalDate('2026-02-30'), false);
  assert.equal(isValidLocalDate('2026-13-01'), false);
  assert.equal(isValidLocalDate('19/10/2026'), false);
});

test('addDays cruza fin de mes, fin de año y bisiesto', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('semana ISO empieza lunes', () => {
  assert.equal(isoWeekday('2026-10-19'), 1); // lunes
  assert.equal(isoWeekday('2026-10-25'), 7); // domingo
  assert.equal(startOfIsoWeek('2026-10-25'), '2026-10-19');
});

test('"hoy" es el día de Lima, no el de UTC', () => {
  // 2026-10-19T02:00Z = 2026-10-18 21:00 en Lima (−05:00).
  const instant = new Date('2026-10-19T02:00:00.000Z');
  assert.equal(todayInTimeZone(instant), '2026-10-18');
  // 2026-10-19T05:00Z = 2026-10-19 00:00 en Lima.
  assert.equal(todayInTimeZone(new Date('2026-10-19T05:00:00.000Z')), '2026-10-19');
});

test('límite de día comercial: 00:00 Lima = 05:00 UTC', () => {
  assert.equal(
    zonedDateTimeToUtc('2026-10-19', 0).toISOString(),
    '2026-10-19T05:00:00.000Z',
  );
});

test('rango 7d usa días comerciales de Lima y límites UTC exclusivos', () => {
  // 22:00 del 18 en Lima (ya es 19 en UTC): el dashboard debe seguir en el 18.
  const resolved = resolveAnalyticsRange({
    preset: '7d',
    now: new Date('2026-10-19T03:00:00.000Z'),
  });

  assert.ok(resolved.ok);
  assert.equal(resolved.range.to, '2026-10-18');
  assert.equal(resolved.range.from, '2026-10-12');
  assert.equal(resolved.range.days, 7);
  assert.equal(resolved.range.fromUtc, '2026-10-12T05:00:00.000Z');
  assert.equal(resolved.range.toUtc, '2026-10-19T05:00:00.000Z');
  assert.equal(resolved.range.timeZone, 'America/Lima');

  // Período anterior: los 7 días inmediatamente previos.
  assert.equal(resolved.previous.from, '2026-10-05');
  assert.equal(resolved.previous.to, '2026-10-11');
});

test('rango "today" cubre exactamente un día', () => {
  const resolved = resolveAnalyticsRange({
    preset: 'today',
    now: new Date('2026-10-19T18:00:00.000Z'),
  });
  assert.ok(resolved.ok);
  assert.equal(resolved.range.from, '2026-10-19');
  assert.equal(resolved.range.to, '2026-10-19');
  assert.equal(resolved.range.days, 1);
});

test('rango 30d incluye hoy y los 29 anteriores', () => {
  const resolved = resolveAnalyticsRange({
    preset: '30d',
    now: new Date('2026-10-19T18:00:00.000Z'),
  });
  assert.ok(resolved.ok);
  assert.equal(resolved.range.from, '2026-09-20');
  assert.equal(resolved.range.to, '2026-10-19');
  assert.equal(resolved.range.days, 30);
});

test('rango personalizado: exige ambas fechas, orden y un tope razonable', () => {
  const missing = resolveAnalyticsRange({ preset: 'custom', from: '2026-10-01' });
  assert.equal(missing.ok, false);

  const inverted = resolveAnalyticsRange({
    preset: 'custom',
    from: '2026-10-10',
    to: '2026-10-01',
  });
  assert.equal(inverted.ok, false);

  const tooLong = resolveAnalyticsRange({
    preset: 'custom',
    from: '2020-01-01',
    to: '2026-10-19',
  });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, new RegExp(String(ANALYTICS_MAX_RANGE_DAYS)));

  const valid = resolveAnalyticsRange({
    preset: 'custom',
    from: '2026-01-01',
    to: '2026-01-31',
  });
  assert.ok(valid.ok);
  assert.equal(valid.range.days, 31);
  assert.equal(valid.range.toUtc, '2026-02-01T05:00:00.000Z');
});

test('preset desconocido falla con error explícito', () => {
  const resolved = resolveAnalyticsRange({ preset: 'all-time' });
  assert.equal(resolved.ok, false);
});

// =============================================================================
//  SERIES
// =============================================================================

test('listDays y listIsoWeeks cubren el rango sin huecos', () => {
  assert.deepEqual(listDays('2026-10-17', '2026-10-19'), [
    '2026-10-17',
    '2026-10-18',
    '2026-10-19',
  ]);

  // Del domingo 18 al lunes 19 hay DOS semanas ISO.
  assert.deepEqual(listIsoWeeks('2026-10-18', '2026-10-19'), ['2026-10-12', '2026-10-19']);
});

test('fillSeries rellena con ceros los días sin ventas', () => {
  const filled = fillSeries(['2026-10-17', '2026-10-18', '2026-10-19'], [
    { bucket: '2026-10-18', orders: 2, revenueCents: 5000 },
  ]);
  assert.deepEqual(filled, [
    { bucket: '2026-10-17', orders: 0, revenueCents: 0 },
    { bucket: '2026-10-18', orders: 2, revenueCents: 5000 },
    { bucket: '2026-10-19', orders: 0, revenueCents: 0 },
  ]);
});

test('describeVariantKey legible y sin inventar datos', () => {
  assert.equal(describeVariantKey(''), 'Estándar');
  assert.equal(describeVariantKey('color:negro|storage:256'), 'color: negro · storage: 256');
  assert.equal(describeVariantKey('talla:M'), 'talla: M');
});
