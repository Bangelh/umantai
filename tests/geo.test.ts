import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RADIUS_KM,
  boundingBox,
  formatDistanceKm,
  haversineKm,
  isValidPoint,
  parseRadius,
} from '../lib/geo';

const LIMA = { latitude: -12.0464, longitude: -77.0428 };
const MIRAFLORES = { latitude: -12.1219, longitude: -77.0297 };
const SURCO = { latitude: -12.145, longitude: -77.005 };
const CALLAO = { latitude: -12.0566, longitude: -77.1181 };

test('Haversine: misma coordenada = 0 km', () => {
  assert.equal(haversineKm(LIMA, LIMA), 0);
});

test('Haversine: Lima Centro → Miraflores ronda 8,5–9,5 km', () => {
  const distance = haversineKm(LIMA, MIRAFLORES);
  assert.ok(distance > 8.5 && distance < 9.5, `distancia inesperada: ${distance}`);
});

test('Haversine es simétrica', () => {
  const a = haversineKm(LIMA, CALLAO);
  const b = haversineKm(CALLAO, LIMA);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('bounding box contiene los puntos dentro del radio y excluye los lejanos', () => {
  const box = boundingBox(LIMA, 5);
  assert.ok(box.minLat <= LIMA.latitude && LIMA.latitude <= box.maxLat);
  assert.ok(box.minLng <= LIMA.longitude && LIMA.longitude <= box.maxLng);

  // Miraflores (~9 km) queda fuera de la caja de 5 km.
  assert.ok(MIRAFLORES.latitude < box.minLat);

  // Surco (~11 km) tampoco entra.
  assert.ok(SURCO.latitude < box.minLat);
});

test('bounding box de 20 km sí incluye Miraflores', () => {
  const box = boundingBox(LIMA, 20);
  assert.ok(MIRAFLORES.latitude >= box.minLat && MIRAFLORES.latitude <= box.maxLat);
});

test('radio: default 5, límites 1–50 y rechazo de inválidos', () => {
  assert.equal(parseRadius(undefined), DEFAULT_RADIUS_KM);
  assert.equal(parseRadius('2'), 2);
  assert.equal(parseRadius(10.5), 10.5);
  assert.equal(parseRadius(0), null);
  assert.equal(parseRadius(51), null);
  assert.equal(parseRadius('abc'), null);
});

test('formato de distancia compacto', () => {
  assert.equal(formatDistanceKm(0.42), '420 m');
  assert.equal(formatDistanceKm(3.24), '3,2 km');
  assert.equal(formatDistanceKm(12.4), '12 km');
  assert.equal(formatDistanceKm(null), '');
});

test('validación de coordenadas', () => {
  assert.equal(isValidPoint(LIMA), true);
  assert.equal(isValidPoint({ latitude: 91, longitude: 0 }), false);
  assert.equal(isValidPoint({ latitude: 0, longitude: 181 }), false);
});
