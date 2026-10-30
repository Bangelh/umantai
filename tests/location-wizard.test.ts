/**
 * tests/location-wizard.test.ts — comportamiento del asistente de ubicación.
 *
 * Lo que se prueba acá es exactamente lo que se rompió en QA: el asistente NO
 * puede cambiar el distrito por su cuenta, y no puede dejar confirmar un pin que
 * está a cientos de kilómetros del distrito elegido.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDistrictSuggestion,
  buildLocationSummary,
  buildLocationValue,
  districtLabel,
  evaluatePinDistance,
  resolveSuggestionChoice,
  type DistrictSelection,
} from '../lib/store-location-wizard';

const MANCORA: DistrictSelection = { department: '20', province: '2007', district: '200706' };
const MANCORA_CENTROID = { latitude: -4.1069, longitude: -81.0539 };
const TRUJILLO_PIN = { latitude: -8.1089557, longitude: -79.0179336 };

const GPS_TRUJILLO = {
  code: '130101',
  district: 'Trujillo',
  province: 'Trujillo',
  department: 'La Libertad',
};

test('GPS en otro distrito propone, pero NO cambia la selección', () => {
  const selection = { ...MANCORA };

  const suggestion = buildDistrictSuggestion({
    source: 'gps',
    currentUbigeo: selection.district,
    detected: GPS_TRUJILLO,
  });

  assert.ok(suggestion);
  assert.equal(suggestion?.code, '130101');
  assert.equal(suggestion?.label, 'Trujillo, Trujillo, La Libertad');
  assert.equal(suggestion?.source, 'gps');
  // La selección sigue intacta: solo se cambia si el usuario lo pide.
  assert.deepEqual(selection, MANCORA);
});

test('aceptar la sugerencia del GPS cambia a Trujillo', () => {
  const suggestion = buildDistrictSuggestion({
    source: 'gps',
    currentUbigeo: MANCORA.district,
    detected: GPS_TRUJILLO,
  });

  const next = resolveSuggestionChoice(MANCORA, suggestion, 'use');
  assert.deepEqual(next, { department: '13', province: '1301', district: '130101' });
});

test('rechazar la sugerencia mantiene Máncora', () => {
  const suggestion = buildDistrictSuggestion({
    source: 'gps',
    currentUbigeo: MANCORA.district,
    detected: GPS_TRUJILLO,
  });

  const next = resolveSuggestionChoice(MANCORA, suggestion, 'keep');
  assert.deepEqual(next, MANCORA);
  assert.equal(next.district, '200706');
});

test('sin sugerencia, aceptar tampoco inventa un cambio', () => {
  assert.deepEqual(resolveSuggestionChoice(MANCORA, null, 'use'), MANCORA);
});

test('el mismo distrito no genera fricción', () => {
  const suggestion = buildDistrictSuggestion({
    source: 'gps',
    currentUbigeo: MANCORA.district,
    detected: { ...GPS_TRUJILLO, code: '200706', district: 'Máncora', province: 'Talara', department: 'Piura' },
  });
  assert.equal(suggestion, null);
});

test('sin código UBIGEO o sin nombres no se propone nada', () => {
  assert.equal(
    buildDistrictSuggestion({ source: 'gps', currentUbigeo: MANCORA.district, detected: null }),
    null,
  );
  assert.equal(
    buildDistrictSuggestion({
      source: 'gps',
      currentUbigeo: MANCORA.district,
      detected: { code: 'abc123', district: 'Trujillo' },
    }),
    null,
  );
  assert.equal(
    buildDistrictSuggestion({
      source: 'gps',
      currentUbigeo: MANCORA.district,
      detected: { code: '130101' },
    }),
    null,
  );
});

test('el geocoder también solo propone', () => {
  const suggestion = buildDistrictSuggestion({
    source: 'geocoder',
    currentUbigeo: MANCORA.district,
    detected: GPS_TRUJILLO,
  });
  assert.equal(suggestion?.source, 'geocoder');
  assert.equal(suggestion?.code, '130101');
});

test('Máncora + pin en Trujillo no permite confirmación directa', () => {
  const verdict = evaluatePinDistance(MANCORA_CENTROID, TRUJILLO_PIN);
  assert.equal(verdict.level, 'blocked');

  const value = buildLocationValue({
    ubigeo: MANCORA.district,
    address: 'Av. Grau 123',
    reference: '',
    marker: TRUJILLO_PIN,
    source: 'map_pin',
    pin: verdict,
  });
  assert.equal(value, null);
});

test('pin sospechoso: sin confirmar no hay payload; confirmado sí', () => {
  const about30km = { latitude: -4.1069 + 0.27, longitude: -81.0539 };

  const pending = evaluatePinDistance(MANCORA_CENTROID, about30km);
  assert.equal(pending.level, 'review');
  assert.equal(
    buildLocationValue({
      ubigeo: MANCORA.district,
      address: 'Av. Grau 123',
      reference: '',
      marker: about30km,
      source: 'map_pin',
      pin: pending,
    }),
    null,
  );

  const confirmed = evaluatePinDistance(MANCORA_CENTROID, about30km, { confirmed: true });
  const value = buildLocationValue({
    ubigeo: MANCORA.district,
    address: 'Av. Grau 123',
    reference: '',
    marker: about30km,
    source: 'map_pin',
    pin: confirmed,
  });
  assert.ok(value);
  assert.equal(value?.confirmFarPin, true);
});

test('el resumen muestra exactamente lo que se va a guardar', () => {
  const marker = { latitude: -4.1051, longitude: -81.0436 };
  const pin = evaluatePinDistance(MANCORA_CENTROID, marker);

  const value = buildLocationValue({
    ubigeo: MANCORA.district,
    address: '  Av. Grau 123  ',
    reference: ' Frente al mercado ',
    marker,
    source: 'geocoder',
    pin,
  });

  const summary = buildLocationSummary({
    ubigeo: MANCORA.district,
    address: '  Av. Grau 123  ',
    marker,
    names: { department: 'Piura', province: 'Talara', district: 'Máncora' },
  });

  assert.ok(value);
  assert.ok(summary);

  // Misma ubicación, misma dirección y mismo pin que el payload.
  assert.equal(summary?.ubigeo, value?.ubigeo);
  assert.equal(summary?.address, value?.address);
  assert.equal(summary?.latitude, value?.latitude);
  assert.equal(summary?.longitude, value?.longitude);

  // Los nombres del catálogo son los que el trigger escribirá en la base.
  assert.deepEqual(
    { department: summary?.department, province: summary?.province, district: summary?.district },
    { department: 'Piura', province: 'Talara', district: 'Máncora' },
  );

  // Ni dirección ni referencia arrastran espacios.
  assert.equal(summary?.address, 'Av. Grau 123');
  assert.equal(value?.reference, 'Frente al mercado');
  assert.equal(value?.source, 'geocoder');
});

test('sin distrito del catálogo no hay resumen', () => {
  assert.equal(
    buildLocationSummary({
      ubigeo: '',
      address: 'Av. Grau 123',
      marker: MANCORA_CENTROID,
      names: {},
    }),
    null,
  );
  assert.equal(
    buildLocationSummary({
      ubigeo: MANCORA.district,
      address: 'ab',
      marker: MANCORA_CENTROID,
      names: { district: 'Máncora' },
    }),
    null,
  );
  assert.equal(
    buildLocationSummary({
      ubigeo: MANCORA.district,
      address: 'Av. Grau 123',
      marker: null,
      names: { district: 'Máncora' },
    }),
    null,
  );
});

test('districtLabel omite lo que falte', () => {
  assert.equal(districtLabel(GPS_TRUJILLO), 'Trujillo, Trujillo, La Libertad');
  assert.equal(districtLabel({ district: 'Máncora', province: 'Talara' }), 'Máncora, Talara');
  assert.equal(districtLabel(null), '');
});
