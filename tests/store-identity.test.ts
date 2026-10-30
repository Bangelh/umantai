/**
 * tests/store-identity.test.ts — reglas puras de la identidad pública.
 *
 * Lo que se prueba acá no toca la base: normalización, formato, reservados y la
 * condición de «nunca publicada». La unicidad case-insensitive y el trigger de
 * la DB se cubren en `store-identity.integration.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canEditStoreIdentity,
  publicStoreUrl,
  validateStoreIdentity,
} from '../lib/store-identity';
import { normalizeStoreSlug } from '../lib/tenancy';

test('normaliza el nombre comercial al slug y arma la dirección pública', () => {
  assert.equal(normalizeStoreSlug('Juan’s Store'), 'juan-s-store');
  assert.equal(publicStoreUrl('Juan’s Store'), 'umantai.com/juan-s-store');
  assert.equal(publicStoreUrl('  Juan Store  '), 'umantai.com/juan-store');
  assert.equal(publicStoreUrl('   '), 'umantai.com');
});

test('acepta un nombre y un slug válidos y los normaliza', () => {
  const result = validateStoreIdentity({ name: '  Juan’s Store ', slug: '  Juan’s  Store ' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.name, 'Juan’s Store');
  assert.equal(result.value.slug, 'juan-s-store');
});

test('rechaza nombre vacío o fuera de rango', () => {
  for (const name of ['', '   ', 'A', 'x'.repeat(81), null, 42]) {
    const result = validateStoreIdentity({ name, slug: 'tienda-valida' });
    assert.equal(result.ok, false, `debería rechazar el nombre ${String(name)}`);
    if (!result.ok) {
      assert.equal(result.code, 'invalid_name');
      assert.equal(result.field, 'name');
    }
  }
});

test('rechaza slug vacío, corto o inválido', () => {
  for (const slug of ['', '   ', 'ab', '---', null, 42]) {
    const result = validateStoreIdentity({ name: 'Tienda Válida', slug });
    assert.equal(result.ok, false, `debería rechazar el slug ${String(slug)}`);
    if (!result.ok) assert.equal(result.field, 'slug');
  }
});

test('rechaza un slug reservado por la plataforma', () => {
  for (const slug of ['admin', 'api', 'vender', 'cuenta', 'UMANTAI']) {
    const result = validateStoreIdentity({ name: 'Tienda', slug });
    assert.equal(result.ok, false, `${slug} debería estar reservado`);
    if (!result.ok) assert.equal(result.code, 'slug_reserved');
  }
});

test('el slug no infiere ni valida la ubicación', () => {
  // `/mancora` es solo una dirección pública: no dice nada del distrito.
  const result = validateStoreIdentity({ name: 'Juan’s Store', slug: 'mancora' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.slug, 'mancora');
  assert.equal(Object.keys(result.value).sort().join(','), 'name,slug');
});

test('solo se puede editar mientras la tienda nunca fue publicada', () => {
  assert.equal(canEditStoreIdentity({ active: false, approvedAt: null }), true);
  assert.equal(canEditStoreIdentity({ active: true, approvedAt: null }), false);
  assert.equal(
    canEditStoreIdentity({ active: false, approvedAt: '2026-10-30T00:00:00.000Z' }),
    false,
  );
  assert.equal(
    canEditStoreIdentity({ active: true, approvedAt: '2026-10-30T00:00:00.000Z' }),
    false,
  );
});
