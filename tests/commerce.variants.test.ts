import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVariantKey,
  enumerateVariantKeys,
  enumerateVariantSelections,
  isValidVariantSelection,
  normalizeVariantSelection,
  variantKeyForSelection,
  type ProductOption,
} from '../lib/commerce';
import { cartItemVariant, cartLineKey } from '../lib/cartStore';
import { baseProductsData, getProductOptions } from '../lib/products';

const TALLA_COLOR: ProductOption[] = [
  { name: 'talla', values: ['S', 'M'] },
  { name: 'color', values: ['negro', 'blanco'] },
];

test('buildVariantKey: recorta, ordena y minusculiza', () => {
  assert.equal(
    buildVariantKey({ storage: '256GB', color: 'Negro' }),
    'color:negro|storage:256gb',
  );
  assert.equal(buildVariantKey({}), '');
});

test('producto sin opciones: solo vale la selección vacía', () => {
  assert.equal(variantKeyForSelection([], {}), '');
  assert.equal(variantKeyForSelection([], { color: 'negro' }), null);
  assert.equal(isValidVariantSelection([], {}), true);
});

test('una opción: valor válido, inválido y ausente', () => {
  const options: ProductOption[] = [{ name: 'talla', values: ['S', 'M', 'L'] }];
  assert.equal(variantKeyForSelection(options, { talla: 'M' }), 'talla:m');
  assert.equal(variantKeyForSelection(options, { talla: 'XL' }), null);
  assert.equal(variantKeyForSelection(options, {}), null);
});

test('dos opciones: exige una por cada eje y ninguna de más', () => {
  assert.equal(variantKeyForSelection(TALLA_COLOR, { talla: 'S', color: 'negro' }), 'color:negro|talla:s');
  assert.equal(variantKeyForSelection(TALLA_COLOR, { talla: 'S' }), null);
  assert.equal(variantKeyForSelection(TALLA_COLOR, { talla: 'S', color: 'negro', peso: '1kg' }), null);
});

test('la comparación de valores ignora mayúsculas y espacios', () => {
  assert.equal(variantKeyForSelection(TALLA_COLOR, { talla: ' s ', color: 'NEGRO' }), 'color:negro|talla:s');
});

test('normalizeVariantSelection descarta claves vacías', () => {
  assert.deepEqual(normalizeVariantSelection({ color: 'Negro', storage: undefined, talla: '  ' }), {
    color: 'Negro',
  });
});

test('enumerateVariantSelections: producto cartesiano y caso sin opciones', () => {
  assert.deepEqual(enumerateVariantKeys([]), ['']);
  const keys = enumerateVariantKeys(TALLA_COLOR).sort();
  assert.deepEqual(keys, [
    'color:blanco|talla:m',
    'color:blanco|talla:s',
    'color:negro|talla:m',
    'color:negro|talla:s',
  ]);
  assert.equal(enumerateVariantSelections(TALLA_COLOR).length, 4);
});

test('getProductOptions: prioriza options y traduce el formato legacy', () => {
  assert.deepEqual(
    getProductOptions({ options: TALLA_COLOR, colors: ['ignorado'], storage: ['ignorado'] }),
    TALLA_COLOR,
  );
  assert.deepEqual(
    getProductOptions({ colors: ['negro', 'blanco'], storage: ['128GB'] }),
    [
      { name: 'color', values: ['negro', 'blanco'] },
      { name: 'storage', values: ['128GB'] },
    ],
  );
  assert.deepEqual(getProductOptions({}), []);
});

test('catálogo de prueba: cubre sin variantes, una opción y dos opciones', () => {
  const dyson = baseProductsData.find((p) => p.slug === 'dyson-v15-detect')!;
  assert.deepEqual(enumerateVariantKeys(getProductOptions(dyson)), ['']);

  const oura = baseProductsData.find((p) => p.slug === 'oura-ring-gen3')!;
  assert.deepEqual(enumerateVariantKeys(getProductOptions(oura)).sort(), [
    'color:gold',
    'color:silver',
    'color:stealth',
  ]);

  const iphone = baseProductsData.find((p) => p.slug === 'iphone-15-pro-titanium')!;
  assert.equal(enumerateVariantKeys(getProductOptions(iphone)).length, 16);
});

test('cartLineKey: variantes distintas no colisionan', () => {
  const a = cartLineKey({ slug: 'iphone', selectedOptions: { color: 'negro', storage: '256GB' } });
  const b = cartLineKey({ slug: 'iphone', selectedOptions: { color: 'negro', storage: '512GB' } });
  const c = cartLineKey({ slug: 'iphone', selectedOptions: { color: 'negro', storage: '256GB' } });
  assert.notEqual(a, b);
  assert.equal(a, c);
});

test('compatibilidad: un item legacy (selectedColor/Storage) se normaliza igual que uno nuevo', () => {
  const legacy = cartLineKey({ slug: 'iphone', selectedColor: 'Negro', selectedStorage: '256GB' });
  const modern = cartLineKey({ slug: 'iphone', selectedOptions: { color: 'Negro', storage: '256GB' } });
  assert.equal(legacy, modern);
  assert.deepEqual(cartItemVariant({ slug: 'iphone', selectedColor: 'Negro', selectedStorage: '256GB' }), {
    color: 'Negro',
    storage: '256GB',
  });
});
