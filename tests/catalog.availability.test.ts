import assert from 'node:assert/strict';
import test from 'node:test';
import { purchaseAvailability, variantsFor } from '../lib/catalogAvailability';
import { enumerateVariantKeys, type ProductOption } from '../lib/commerce';
import { baseProductsData, getProductOptions } from '../lib/products';

/**
 * La autoridad del catálogo es `inventory`, no `product.inStock`.
 *
 * Estos tests son la red que impide volver a la divergencia que dejaba agregar al
 * carrito un producto con `quantity_available = 0` (el rechazo aparecía recién en
 * el checkout, con 409 `insufficient_stock`).
 */

/** Producto sin variantes. `variant_key` canónico = `''`. */
const SIN_OPCIONES = {
  slug: 'demo-sin-opciones',
  options: undefined,
  colors: undefined,
  storage: undefined,
};

const COLOR: ProductOption[] = [{ name: 'color', values: ['negro', 'blanco'] }];
const CON_OPCIONES = { slug: 'demo-con-opciones', options: COLOR, colors: undefined, storage: undefined };

test('available = 0 → no se puede agregar y la etiqueta dice que está agotado', () => {
  const purchase = purchaseAvailability(SIN_OPCIONES, { '': 0 }, {});
  assert.equal(purchase.variantKey, '');
  assert.equal(purchase.available, 0);
  assert.equal(purchase.canAdd, false);
  assert.equal(purchase.label, 'out-of-stock');
});

test('available > 0 → se puede agregar', () => {
  const purchase = purchaseAvailability(SIN_OPCIONES, { '': 7 }, {});
  assert.equal(purchase.available, 7);
  assert.equal(purchase.canAdd, true);
  assert.equal(purchase.label, 'add');
});

test('sin datos de inventario (null) → NO se autoriza a ciegas', () => {
  const purchase = purchaseAvailability(SIN_OPCIONES, null, {});
  assert.equal(purchase.available, null);
  assert.equal(purchase.canAdd, false);
  assert.equal(purchase.label, 'checking');
});

test('variante sin fila en inventory cuenta como agotada, no como desconocida', () => {
  // La respuesta llegó (el producto existe), pero esa combinación no tiene fila.
  const purchase = purchaseAvailability(CON_OPCIONES, { 'color:negro': 0 }, { color: 'negro' });
  assert.equal(purchase.available, 0);
  assert.equal(purchase.canAdd, false);
  assert.equal(purchase.label, 'out-of-stock');
});

test('selección incompleta en producto con opciones → pide elegir, no autoriza', () => {
  const purchase = purchaseAvailability(CON_OPCIONES, { 'color:negro': 9 }, {});
  assert.equal(purchase.variantKey, null);
  assert.equal(purchase.isSelectionComplete, false);
  assert.equal(purchase.available, null);
  assert.equal(purchase.canAdd, false);
  assert.equal(purchase.label, 'select-options');
});

test('la disponibilidad es POR VARIANTE: no se suma ni se usa el total del producto', () => {
  const variants = { 'color:negro': 3, 'color:blanco': 0 };

  assert.equal(purchaseAvailability(CON_OPCIONES, variants, { color: 'negro' }).available, 3);
  assert.equal(purchaseAvailability(CON_OPCIONES, variants, { color: 'negro' }).canAdd, true);

  const blanco = purchaseAvailability(CON_OPCIONES, variants, { color: 'blanco' });
  assert.equal(blanco.available, 0, 'blanco agotado no hereda el stock de negro');
  assert.equal(blanco.canAdd, false);
});

test('el stock real contradice a inStock legacy en AMBOS sentidos', () => {
  // 1) Los datos demo dicen que hay stock, el inventario dice 0 → manda el inventario.
  const demoConStock = { ...SIN_OPCIONES, inStock: 999 };
  const agotado = purchaseAvailability(demoConStock, { '': 0 }, {});
  assert.equal(agotado.canAdd, false);
  assert.equal(agotado.label, 'out-of-stock');

  // 2) Los datos demo dicen 0, el inventario dice que sí hay → manda el inventario.
  const demoAgotado = { ...SIN_OPCIONES, inStock: 0 };
  const disponible = purchaseAvailability(demoAgotado, { '': 5 }, {});
  assert.equal(disponible.canAdd, true);
  assert.equal(disponible.label, 'add');
});

test('variantsFor: null cuando no hay respuesta o el slug no está en la respuesta', () => {
  assert.equal(variantsFor(null, 'dyson-v15-detect'), null);
  assert.equal(variantsFor({}, 'dyson-v15-detect'), null);

  const map = { 'dyson-v15-detect': { variants: { '': 2 }, totalAvailable: 2 } };
  assert.deepEqual(variantsFor(map, 'dyson-v15-detect'), { '': 2 });
});

test('catálogo real: producto sin variantes decide por inventory', () => {
  const dyson = baseProductsData.find((product) => product.slug === 'dyson-v15-detect')!;
  assert.deepEqual(enumerateVariantKeys(getProductOptions(dyson)), ['']);

  assert.equal(purchaseAvailability(dyson, { '': 0 }, {}).canAdd, false);
  assert.equal(purchaseAvailability(dyson, { '': 1 }, {}).canAdd, true);
});

test('catálogo real: producto con variantes respeta el variantKey elegido', () => {
  const oura = baseProductsData.find((product) => product.slug === 'oura-ring-gen3')!;
  const variants = { 'color:gold': 4 };

  // `variantKeyForSelection` normaliza: `Gold` → `color:gold`.
  assert.equal(purchaseAvailability(oura, variants, { color: 'Gold' }).available, 4);
  assert.equal(purchaseAvailability(oura, variants, { color: 'Gold' }).canAdd, true);

  // La variante silver no tiene fila: agotada (no "hereda" las 4 de gold).
  assert.equal(purchaseAvailability(oura, variants, { color: 'silver' }).available, 0);
  assert.equal(purchaseAvailability(oura, variants, { color: 'silver' }).canAdd, false);
});
