/**
 * tests/store-status.test.ts — contrato del estado visible de una tienda.
 *
 * Protege la distinción que la UI antes no hacía: "pendiente" no es lo mismo
 * que "le falta algo al comerciante". Una tienda sin coordenadas no puede
 * activarse (`stores_active_location_chk`), así que anunciarla como "en
 * revisión" sería prometer algo que el administrador no puede cumplir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMerchantStoreStatus } from '../lib/store-status';

test('una tienda activa se reporta como activa y no ofrece acciones', () => {
  const status = resolveMerchantStoreStatus({ active: true, latitude: -12.04, longitude: -77.03 });
  assert.equal(status.state, 'active');
  assert.equal(status.canActivate, false);
  assert.equal(status.missing, null);
});

test('una tienda inactiva sin ubicación está incompleta, no en revisión', () => {
  const status = resolveMerchantStoreStatus({ active: false, latitude: null, longitude: null });
  assert.equal(status.state, 'incomplete');
  assert.equal(status.missing, 'location');
  assert.equal(status.hasLocation, false);
  assert.equal(status.canActivate, false);
});

test('media ubicación tampoco alcanza: se exige latitud y longitud', () => {
  const status = resolveMerchantStoreStatus({ active: false, latitude: -12.04, longitude: null });
  assert.equal(status.state, 'incomplete');
  assert.equal(status.missing, 'location');
});

test('una tienda inactiva y completa espera revisión del administrador', () => {
  const status = resolveMerchantStoreStatus({ active: false, latitude: -12.04, longitude: -77.03 });
  assert.equal(status.state, 'pending_review');
  assert.equal(status.missing, null);
  assert.equal(status.canActivate, true);
});

test('la verificación de correo no participa: el estado depende solo de la tienda', () => {
  // La firma no acepta nada relacionado con la cuenta: si alguien intentara
  // acoplar ambos estados, este test deja de compilar.
  const input = { active: false, latitude: -12.04, longitude: -77.03 };
  assert.equal(resolveMerchantStoreStatus(input).state, 'pending_review');
});
