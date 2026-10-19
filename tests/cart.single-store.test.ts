/**
 * tests/cart.single-store.test.ts — regla de negocio del carrito.
 *
 * El carrito NUNCA mezcla tiendas: al agregar un producto de otra tienda
 * devuelve un conflicto y la UI pide confirmación. `switchStore` es la única
 * operación que vacía el carrito anterior de forma explícita.
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

type CartModule = typeof import('../lib/cartStore');
type Product = import('../lib/products').Product;

let cart: CartModule;

function product(storeSlug: string, slug: string): Product {
  return {
    slug,
    name: slug,
    brand: 'Marca',
    price: 10,
    category: 'test',
    description: '',
    specs: [],
    inStock: 5,
    rating: 0,
    reviewCount: 0,
    images: [],
    storeId: `store-${storeSlug}`,
    storeSlug,
    storeName: `Tienda ${storeSlug.toUpperCase()}`,
  };
}

const state = () => cart.useCartStore.getState();

before(async () => {
  // `persist` necesita un storage; en Node no existe localStorage.
  const memory = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  };
  Object.assign(globalThis, { localStorage, window: { localStorage } });
  cart = await import('../lib/cartStore');
  state().clearCart();
});

test('carrito vacío adopta la tienda del primer producto', () => {
  const result = state().addItem(product('bodega-a', 'arroz'), 2);

  assert.deepEqual(result, { status: 'added' });
  assert.equal(state().items.length, 1);
  assert.deepEqual(state().getStore(), {
    storeId: 'store-bodega-a',
    storeSlug: 'bodega-a',
    storeName: 'Tienda BODEGA-A',
  });
});

test('misma tienda: suma normalmente, incluso con otra variante', () => {
  const result = state().addItem(product('bodega-a', 'arroz'), 1, { presentacion: '1 kg' });
  assert.deepEqual(result, { status: 'added' });
  assert.equal(state().items.length, 2);
  assert.equal(state().getTotalItems(), 3);
});

test('otra tienda: NO agrega en silencio y devuelve conflicto', () => {
  const before = state().items;
  const result = state().addItem(product('market-b', 'polo'));

  assert.equal(result.status, 'conflict');
  if (result.status !== 'conflict') return;
  assert.equal(result.current.storeSlug, 'bodega-a');
  assert.equal(result.next.storeSlug, 'market-b');
  assert.equal(state().items, before, 'el carrito no debe cambiar');
  assert.equal(state().getStore().storeSlug, 'bodega-a');
});

test('cambiar de tienda limpia el carrito anterior y adopta la nueva', () => {
  state().switchStore(product('market-b', 'polo'), 3, { talla: 'M' });

  assert.equal(state().items.length, 1);
  assert.equal(state().items[0]?.slug, 'polo');
  assert.equal(state().items[0]?.quantity, 3);
  assert.equal(state().getStore().storeSlug, 'market-b');
});

test('quitar la última línea resetea la tienda del carrito', () => {
  const key = cart.cartLineKey(state().items[0]!);
  state().removeItem(key);

  assert.equal(state().items.length, 0);
  assert.deepEqual(state().getStore(), { storeId: null, storeSlug: null, storeName: null });
});

test('un carrito antiguo sin metadata deriva la tienda de su primera línea', async () => {
  // Antes de esta fase, la tienda vivía solo en cada línea (no en el estado
  // superior). El merge debe reconstruirla sin perder el carrito.
  const legacyProduct = { ...product('bodega-a', 'arroz'), quantity: 1 };
  const legacy = { state: { items: [legacyProduct] }, version: 0 };
  localStorage.setItem('umantai-cart', JSON.stringify(legacy));

  // La rehidratación manual usa el mismo merge que aplica zustand al arrancar.
  await cart.useCartStore.persist.rehydrate();
  assert.equal(state().getStore().storeSlug, 'bodega-a');
  assert.equal(state().items.length, 1);
});
