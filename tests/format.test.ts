import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCoordinates,
  formatDate,
  formatDateTime,
  formatDistance,
  formatMoney,
  formatMoneyUnits,
  formatNumber,
  formatPercent,
  formatTime,
} from '../lib/format';

test('moneda: separador decimal según locale y símbolo estable', () => {
  assert.equal(formatMoney(1250, 'PEN', 'es'), 'S/ 12,50');
  assert.equal(formatMoney(1250, 'PEN', 'en'), 'S/ 12.50');
  assert.equal(formatMoney(400, 'USD', 'en'), '$ 4.00');
  assert.equal(formatMoney(0, 'PEN', 'es'), 'S/ 0,00');
});

test('moneda: valores inválidos no producen NaN', () => {
  assert.equal(formatMoney(Number.NaN, 'PEN', 'es'), 'S/ 0,00');
  assert.equal(formatMoney(-500, 'PEN', 'es'), 'S/ 0,00');
});

test('moneda en unidades usa centavos internamente', () => {
  assert.equal(formatMoneyUnits(12.5, 'PEN', 'es'), 'S/ 12,50');
  assert.equal(formatMoneyUnits(0.1 + 0.2, 'PEN', 'en'), 'S/ 0.30');
});

test('números y porcentajes respetan el locale', () => {
  // es-PE usa coma de miles y punto decimal (igual que en-US, pero Intl lo
  // resuelve por locale para no hardcodear el separador).
  assert.equal(formatNumber(1234.5, 'es'), '1,234.5');
  assert.equal(formatNumber(1234.5, 'en'), '1,234.5');
  assert.equal(formatPercent(12.34, 'es'), '12.3%');
  assert.equal(formatPercent(12.34, 'en'), '12.3%');
});

test('fechas y horas usan la zona del negocio', () => {
  const date = '2026-10-20T15:30:00.000Z';
  assert.match(formatDate(date, 'es'), /2026/);
  assert.match(formatDateTime(date, 'es'), /2026/);
  assert.match(formatTime(date, 'es'), /\d{1,2}:\d{2}/);
  assert.equal(formatDate('', 'es'), '');
  assert.equal(formatDate('not-a-date', 'es'), '');
});

test('distancia compacta cambia el separador, no la unidad', () => {
  assert.equal(formatDistance(0.42, 'es'), '420 m');
  assert.equal(formatDistance(3.2, 'es'), '3,2 km');
  assert.equal(formatDistance(3.2, 'en'), '3.2 km');
  assert.equal(formatDistance(12.6, 'es'), '13 km');
  assert.equal(formatDistance(null, 'es'), '');
});

test('coordenadas legibles con cuatro decimales', () => {
  assert.equal(formatCoordinates(-12.0464, -77.0428), '-12.0464, -77.0428');
});
