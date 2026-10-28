/**
 * tests/money.contract.test.ts — contrato monetario de UMANTAI.
 *
 * Cubre el bug P0 real: un producto de S/ 12,00 con variante se mostraba en el
 * carrito como S/ 1200,00. La causa no fue el formato sino la MEZCLA de
 * unidades: la página mandaba el precio base en soles y la variante en
 * centavos, y el carrito (que trabaja en soles) recibía 1200.
 *
 * Estos tests fijan las dos representaciones y su única frontera:
 *   · persistencia → centavos enteros
 *   · dominio de pedidos y carrito → soles con 2 decimales
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  centsToInput,
  centsToUnits,
  formatMoney,
  formatMoneyUnits,
  parseMoneyInputToCents,
  unitsToCents,
} from '../lib/format';
import { buildCheckoutSummary, roundMoney } from '../lib/checkout';

test('la frontera centavos ↔ soles es exacta para precios con céntimos', () => {
  for (const [units, cents] of [
    [12, 1200],
    [3.5, 350],
    [10.9, 1090],
    [0.5, 50],
    [0.01, 1],
    [1200, 120000],
  ] as const) {
    assert.equal(unitsToCents(units), cents, `${units} soles → ${cents} centavos`);
    assert.equal(centsToUnits(cents), units, `${cents} centavos → ${units} soles`);
  }
});

test('la ida y vuelta no acumula error de float', () => {
  for (const cents of [1200, 350, 1090, 50, 1, 999999]) {
    assert.equal(unitsToCents(centsToUnits(cents)), cents);
  }
  assert.equal(unitsToCents(0.1 + 0.2), 30);
  assert.equal(unitsToCents(roundMoney(0.1 + 0.2)), 30);
});

test('REG-01: S/ 12,00 × 1 se muestra como S/ 12,00 (bug del carrito ×100)', () => {
  // Precio canónico del catálogo: 1200 centavos.
  const variantPriceCents = 1200;

  // Lo que hace la UI: muestra en centavos y entrega SOLO soles al carrito.
  assert.equal(formatMoney(variantPriceCents, 'PEN', 'es'), 'S/ 12,00');

  const cartUnitPrice = centsToUnits(variantPriceCents);
  assert.equal(cartUnitPrice, 12);
  assert.equal(formatMoneyUnits(cartUnitPrice * 1, 'PEN', 'es'), 'S/ 12,00');

  // Regresión explícita: el valor en centavos NUNCA debe entrar al carrito.
  assert.equal(formatMoneyUnits(variantPriceCents, 'PEN', 'es'), 'S/ 1200,00');
});

test('REG-02: S/ 12,00 × 2 = S/ 24,00 en carrito y en el resumen de checkout', () => {
  const unitPrice = centsToUnits(1200);
  assert.equal(formatMoneyUnits(unitPrice * 2, 'PEN', 'es'), 'S/ 24,00');

  const summary = buildCheckoutSummary([
    { name: 'Arroz a granel', brand: 'Bodega La Esquina', price: unitPrice, quantity: 2, variant: { presentacion: '1 kg' } },
  ]);
  assert.equal(summary.total, 24);
  assert.equal(formatMoneyUnits(summary.total, 'PEN', 'es'), 'S/ 24,00');
  assert.equal(summary.lines[0]?.variantLabel, '1 kg');
  assert.equal(formatMoneyUnits(summary.lines[0]!.unitPrice, 'PEN', 'es'), 'S/ 12,00');
});

test('REG-03: precios con céntimos y cantidades mayores a 1 no pierden precisión', () => {
  const cases: [number, number, string][] = [
    [350, 1, 'S/ 3,50'],
    [350, 3, 'S/ 10,50'],
    [1090, 2, 'S/ 21,80'],
    [1090, 7, 'S/ 76,30'],
    [50, 9, 'S/ 4,50'],
    [1, 3, 'S/ 0,03'],
  ];
  for (const [cents, quantity, expected] of cases) {
    const lineTotal = roundMoney(centsToUnits(cents) * quantity);
    assert.equal(formatMoneyUnits(lineTotal, 'PEN', 'es'), expected);
  }
});

test('REG-04: el total del carrito en soles se formatea una sola vez', () => {
  // Dos líneas de 12,00 y 3,50 en soles (como los guarda zustand).
  const total = roundMoney(12 * 1 + 3.5 * 2);
  assert.equal(total, 19);
  assert.equal(formatMoneyUnits(total, 'PEN', 'es'), 'S/ 19,00');
  assert.equal(formatMoneyUnits(total, 'PEN', 'en'), 'S/ 19.00');
});

test('REG-05: un carrito persistido con soles se rehidrata sin multiplicarse', async () => {
  const memory = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  };
  Object.assign(globalThis, { localStorage, window: { localStorage } });

  const cart = await import('../lib/cartStore');
  const state = () => cart.useCartStore.getState();
  state().clearCart();

  state().addItem(
    {
      slug: 'arroz-granel',
      name: 'Arroz a granel',
      brand: 'Bodega La Esquina',
      price: centsToUnits(1200),
      category: 'Abarrotes',
      description: '',
      specs: [],
      inStock: 30,
      rating: 0,
      reviewCount: 0,
      images: [],
      storeId: 'store-bodega',
      storeSlug: 'bodega-la-esquina',
      storeName: 'Bodega La Esquina',
    },
    1,
    { presentacion: '1 kg' },
  );

  await cart.useCartStore.persist.rehydrate();

  // 1 unidad × S/ 12,00, no S/ 1200,00.
  assert.equal(state().items.length, 1);
  assert.equal(state().items[0]?.price, 12);
  assert.equal(state().getTotalPrice(), 12);
  assert.equal(formatMoneyUnits(state().getTotalPrice(), 'PEN', 'es'), 'S/ 12,00');

  state().updateQuantity(cart.cartLineKey(state().items[0]!), 2);
  assert.equal(formatMoneyUnits(state().getTotalPrice(), 'PEN', 'es'), 'S/ 24,00');

  state().clearCart();
});

test('inputs del comercio: texto con coma o punto va a centavos y de vuelta', () => {
  assert.equal(parseMoneyInputToCents('12,50'), 1250);
  assert.equal(parseMoneyInputToCents('12.50'), 1250);
  assert.equal(parseMoneyInputToCents(' 3,5 '), 350);
  assert.equal(parseMoneyInputToCents(''), null);
  assert.equal(parseMoneyInputToCents('   '), null);
  assert.equal(parseMoneyInputToCents('abc'), null);
  assert.equal(parseMoneyInputToCents('-5'), null);
  assert.equal(centsToInput(1250), '12.50');
  assert.equal(centsToInput(null), '');
});

test('el formato de dinero nunca produce NaN', () => {
  assert.equal(formatMoney(Number.NaN, 'PEN', 'es'), 'S/ 0,00');
  assert.equal(formatMoneyUnits(Number.POSITIVE_INFINITY, 'PEN', 'es'), 'S/ 0,00');
});

test('guarda: no hay conversiones de dinero dispersas en app/ ni lib/', () => {
  // Un `/ 100` o `* 100` suelto sobre un campo monetario es exactamente el bug
  // que produjo S/ 1200,00. Todo debe pasar por lib/format.ts.
  const forbidden = [
    /priceCents\s*\/\s*100/,
    /priceCents\s*\*\s*100/,
    /amountCents\s*\/\s*100/,
    /amountCents\s*\*\s*100/,
    /firstAmountCents\s*\/\s*100/,
  ];

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (path === join('lib', 'format.ts')) continue;
      const source = readFileSync(path, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${path} → ${pattern}`);
      }
    }
  };
  walk('app');
  walk('lib');

  assert.deepEqual(offenders, [], `conversión monetaria fuera de lib/format.ts:\n${offenders.join('\n')}`);
});
