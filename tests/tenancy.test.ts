import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESERVED_STORE_SLUGS,
  TenancyError,
  canManageStoreMembers,
  canOperateStore,
  normalizeStoreSlug,
  roleAtLeast,
  storeProductPath,
  validateStoreSlug,
} from '../lib/tenancy';

test('normaliza nombres comerciales a slugs', () => {
  assert.equal(normalizeStoreSlug('Telas del Sur'), 'telas-del-sur');
  assert.equal(normalizeStoreSlug('Café & Té Ñandú'), 'cafe-te-nandu');
  assert.equal(normalizeStoreSlug('  A--B  '), 'a-b');
  assert.equal(normalizeStoreSlug('Abarrotes   La  Esquina'), 'abarrotes-la-esquina');
});

test('slug válido: minúsculas, números y guiones', () => {
  const result = validateStoreSlug('Bodega La Esquina 2');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.slug, 'bodega-la-esquina-2');
});

test('slug reservado se rechaza (admin, api, legal, products…)', () => {
  for (const reserved of ['admin', 'api', 'login', 'legal', 'contacto', 'products', 'cart', 'cuenta', 'vender']) {
    const result = validateStoreSlug(reserved);
    assert.equal(result.ok, false, `${reserved} debería estar reservado`);
    if (!result.ok) assert.equal(result.code, 'slug_reserved');
  }
  assert.ok(RESERVED_STORE_SLUGS.has('admin'));
});

test('slug demasiado corto o inválido', () => {
  assert.equal(validateStoreSlug('ab').ok, false);
  const invalid = validateStoreSlug('---');
  assert.equal(invalid.ok, false);
});

test('roles: admin opera, owner gestiona miembros', () => {
  assert.equal(canOperateStore('admin'), true);
  assert.equal(canOperateStore('owner'), true);
  assert.equal(canOperateStore(null), false);
  assert.equal(canManageStoreMembers('admin'), false);
  assert.equal(canManageStoreMembers('owner'), true);
  assert.equal(roleAtLeast('owner', 'admin'), true);
  assert.equal(roleAtLeast('admin', 'owner'), false);
});

test('errores de tenancy traen status HTTP coherente', () => {
  assert.equal(new TenancyError('not_authenticated', 'x').status, 401);
  assert.equal(new TenancyError('store_forbidden', 'x').status, 403);
  assert.equal(new TenancyError('store_not_found', 'x').status, 404);
  assert.equal(new TenancyError('store_slug_taken', 'x').status, 409);
  assert.equal(new TenancyError('invalid_store_input', 'x').status, 400);
});

test('rutas públicas de tienda y producto', () => {
  assert.equal(storeProductPath('telas-del-sur', 'tela-lino'), '/telas-del-sur/p/tela-lino');
});
