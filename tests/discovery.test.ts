import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareDiscoveryProducts,
  formatPriceCents,
  normalizeQuery,
  parseDiscoveryQuery,
  relevanceRank,
  type DiscoveryProduct,
} from '../lib/discovery';

function product(partial: Partial<DiscoveryProduct> & Pick<DiscoveryProduct, 'name'>): DiscoveryProduct {
  return {
    storeId: 's1',
    storeSlug: 'tienda',
    storeName: 'Tienda',
    storeCategory: null,
    productSlug: partial.name.toLowerCase().replace(/\s+/g, '-'),
    brand: null,
    category: null,
    description: null,
    priceCents: 1000,
    currency: 'PEN',
    unit: 'unidad',
    available: 1,
    inStock: true,
    distanceKm: null,
    variantCount: 0,
    hasVariants: false,
    ...partial,
  };
}

test('normaliza la consulta: recorta, colapsa espacios y corta a 80', () => {
  assert.equal(normalizeQuery('  arroz   integral  '), 'arroz integral');
  assert.equal(normalizeQuery('a'.repeat(120)).length, 80);
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery('a\u0000b'), 'a b');
});

test('query válida con ubicación, radio y paginación', () => {
  const params = new URLSearchParams('q=arroz&lat=-12.05&lng=-77.04&radius=5&limit=20&offset=10');
  const result = parseDiscoveryQuery(params);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.query.q, 'arroz');
  assert.deepEqual(result.query.location, { latitude: -12.05, longitude: -77.04 });
  assert.equal(result.query.radiusKm, 5);
  assert.equal(result.query.limit, 20);
  assert.equal(result.query.offset, 10);
});

test('sin coordenadas la búsqueda es global (no bloquea)', () => {
  const result = parseDiscoveryQuery(new URLSearchParams('q=tela'));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.query.location, null);
});

test('coordenadas incompletas o fuera de rango → 400', () => {
  const incomplete = parseDiscoveryQuery(new URLSearchParams('q=x&lat=-12'));
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.code, 'incomplete_coordinates');

  const invalid = parseDiscoveryQuery(new URLSearchParams('q=x&lat=-120&lng=-77'));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'invalid_coordinates');
});

test('radio, límite y offset inválidos → 400', () => {
  const radius = parseDiscoveryQuery(new URLSearchParams('radius=0'));
  assert.equal(radius.ok, false);
  if (!radius.ok) assert.equal(radius.code, 'invalid_radius');

  const limit = parseDiscoveryQuery(new URLSearchParams('limit=500'));
  assert.equal(limit.ok, false);

  const offset = parseDiscoveryQuery(new URLSearchParams('offset=-1'));
  assert.equal(offset.ok, false);
});

test('relevancia: exacto > prefijo > contiene > marca', () => {
  assert.equal(relevanceRank({ name: 'Arroz' }, 'arroz'), 0);
  assert.equal(relevanceRank({ name: 'Arroz integral' }, 'arroz'), 1);
  assert.equal(relevanceRank({ name: 'Arroz blanco premium' }, 'arroz'), 1);
  assert.equal(relevanceRank({ name: 'Saco de arroz' }, 'arroz'), 2);
  assert.equal(relevanceRank({ name: 'Costal', brand: 'Arroz del Norte' }, 'arroz'), 3);
  assert.equal(relevanceRank({ name: 'Costal', masterName: 'Arroz canónico' }, 'arroz'), 4);
});

test('orden: relevancia y luego distancia', () => {
  const items = [
    product({ name: 'Saco de arroz', distanceKm: 1 }),
    product({ name: 'Arroz integral', distanceKm: 8 }),
    product({ name: 'Arroz integral', distanceKm: 2 }),
  ];
  items.sort((a, b) => compareDiscoveryProducts(a, b, 'arroz'));
  assert.deepEqual(
    items.map((item) => item.distanceKm),
    [2, 8, 1],
  );
});

test('precios en centavos con símbolo de moneda', () => {
  assert.equal(formatPriceCents(1250), 'S/ 12,50');
  assert.equal(formatPriceCents(0), 'S/ 0,00');
  assert.equal(formatPriceCents(999, 'USD'), '$ 9,99');
  assert.equal(formatPriceCents(100, 'GBP'), 'GBP 1,00');
});
