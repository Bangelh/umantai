/**
 * tests/store-location.test.ts — validación del payload de ubicación.
 *
 * Contrato: el cliente solo aporta ubigeo, dirección, referencia y el pin. Los
 * nombres administrativos los deriva la base; cualquier cosa fuera del Perú o
 * sin pin se rechaza antes de tocar la DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceKm, foldGeoText, isPointInPeru, sanitizeAddress } from '../lib/geo/peru';
import { validateStoreLocation } from '../lib/store-location';

const UBIGEO_MANCORA = '200706';
const PIN_MANCORA = { latitude: -4.1069, longitude: -81.0539 };

const valid = {
  ubigeo: UBIGEO_MANCORA,
  address: '  Av.  Grau   123  ',
  reference: '  Frente al mercado ',
  latitude: PIN_MANCORA.latitude,
  longitude: PIN_MANCORA.longitude,
  source: 'map_pin',
};

test('acepta una ubicación completa y sanea los textos', () => {
  const result = validateStoreLocation(valid);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.ubigeo, UBIGEO_MANCORA);
  assert.equal(result.value.address, 'Av. Grau 123');
  assert.equal(result.value.reference, 'Frente al mercado');
  assert.equal(result.value.source, 'map_pin');
  assert.deepEqual(result.warnings, []);
});

test('la referencia es opcional de verdad', () => {
  const result = validateStoreLocation({ ...valid, reference: '' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.reference, null);
});

test('rechaza UBIGEO con formato inválido', () => {
  for (const ubigeo of ['', '20070', '2007066', 'abc123', null, 200706]) {
    const result = validateStoreLocation({ ...valid, ubigeo });
    assert.equal(result.ok, false, `debería rechazar ${String(ubigeo)}`);
    if (!result.ok) assert.equal(result.code, 'invalid_ubigeo');
  }
});

test('rechaza direcciones vacías o demasiado cortas', () => {
  for (const address of ['', '   ', 'ab', null]) {
    const result = validateStoreLocation({ ...valid, address });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_address');
  }
});

test('rechaza un pin ausente o no numérico', () => {
  for (const [latitude, longitude] of [
    [null, null],
    ['x', -81],
    [undefined, -81],
  ]) {
    const result = validateStoreLocation({ ...valid, latitude, longitude });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_point');
  }
});

test('rechaza un pin fuera del Perú (ceros y otro país)', () => {
  const outside = [
    { latitude: 0, longitude: 0 },
    { latitude: -12.04, longitude: -60.0 }, // Bolivia/Brasil
    { latitude: 4.6, longitude: -74.08 }, // Bogotá
  ];
  for (const point of outside) {
    assert.equal(isPointInPeru(point), false);
    const result = validateStoreLocation({ ...valid, ...point });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'point_outside_peru');
  }
});

test('acepta el pin de Máncora y Lima', () => {
  assert.equal(isPointInPeru(PIN_MANCORA), true);
  assert.equal(isPointInPeru({ latitude: -12.0464, longitude: -77.0428 }), true);
});

test('un origen de ubicación desconocido no se acepta', () => {
  const result = validateStoreLocation({ ...valid, source: 'teleport' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid_source');
});

test('la distancia al centroide es advertencia, no bloqueo', () => {
  const result = validateStoreLocation(valid, { nearCentroidKm: 200 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.warnings, ['pin_far_from_district']);
});

test('Haversine coincide con distancias conocidas del Perú', () => {
  // Máncora (Talara) ↔ Piura capital: ~130 km en línea recta.
  const km = distanceKm(
    { latitude: -4.1069, longitude: -81.0539 },
    { latitude: -5.1945, longitude: -80.6328 },
  );
  assert.ok(km > 125 && km < 135, `distancia inesperada: ${km}`);
  assert.equal(Math.round(distanceKm(PIN_MANCORA, PIN_MANCORA)), 0);
});

test('sanitizeAddress no deja controles ni espacios dobles', () => {
  assert.equal(sanitizeAddress('Calle\u0000 1 2\n3'), 'Calle 1 2 3');
  assert.equal(sanitizeAddress('   '), null);
  assert.equal(sanitizeAddress('x'.repeat(400))?.length, 160);
});

test('foldGeoText ignora tildes y mayúsculas', () => {
  assert.equal(foldGeoText('MÁNCORA'), 'mancora');
  assert.equal(foldGeoText('  San   Isidro '), 'san isidro');
});
