// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`.
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET as receiptPlanRoute } from '../app/api/admin/inventory/receipt-plan/route';
import {
  buildReceiptPlan,
  enumerateCatalogCombinations,
  type CatalogCombination,
  type InventorySnapshotRow,
} from '../lib/inventory-receipt-plan';
import { baseProductsData, type Product } from '../lib/products';

/**
 * Plan de reposición READ-ONLY (auditoría previa a los receipts).
 *
 * ⚠️ LIMITACIÓN (igual que el resto de las suites de comercio): no hay Postgres en los
 * tests. Se prueba el cruce PURO catálogo × `inventory` y los candados de la ruta; la
 * lectura real la hace `GET /api/admin/inventory/receipt-plan` contra la base.
 */

const ADMIN_SECRET = 'test-admin-secret-0123456789';

type EnvMap = Record<string, string | undefined>;
async function withEnv<T>(env: EnvMap, fn: () => Promise<T> | T): Promise<T> {
  const saved: EnvMap = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type PlanRequest = Parameters<typeof receiptPlanRoute>[0];

// =============================================================================
//  1. ENUMERACIÓN DEL CATÁLOGO
// =============================================================================

test('catálogo: expande opciones a combinaciones y deja sin variante a los simples', () => {
  const products = [
    {
      slug: 'p-multi',
      name: 'Multi',
      options: [
        { name: 'color', values: ['negro', 'blanco'] },
        { name: 'talla', values: ['s', 'm'] },
      ],
    },
    { slug: 'p-simple', name: 'Simple' },
  ] as unknown as Product[];

  const combinations = enumerateCatalogCombinations(products);

  assert.equal(combinations.length, 5, '2×2 del multi + 1 del simple');
  const simple = combinations.find((c) => c.productSlug === 'p-simple');
  assert.equal(simple?.variantKey, '', 'producto sin opciones → variant_key vacío');
  assert.equal(
    combinations.filter((c) => c.productSlug === 'p-multi').length,
    4,
    'producto con 2 opciones de 2 valores → 4 combinaciones',
  );
});

test('catálogo actual: 24 productos y 43 combinaciones activas', () => {
  const combinations = enumerateCatalogCombinations(baseProductsData);
  assert.equal(new Set(combinations.map((c) => c.productSlug)).size, 24);
  assert.equal(combinations.length, 43);
});

// =============================================================================
//  2. CRUCE catálogo × inventory
// =============================================================================

const COMBOS: CatalogCombination[] = [
  { productSlug: 'a', productName: 'A', variantKey: '' },
  { productSlug: 'b', productName: 'B', variantKey: 'x:1' },
  { productSlug: 'c', productName: 'C', variantKey: '' },
  { productSlug: 'd', productName: 'D', variantKey: '' },
];

const INVENTORY: InventorySnapshotRow[] = [
  { productSlug: 'a', variantKey: '', quantityOnHand: 10, quantityReserved: 6, quantityAvailable: 4 },
  { productSlug: 'b', variantKey: 'x:1', quantityOnHand: 12, quantityReserved: 0, quantityAvailable: 12 },
  { productSlug: 'd', variantKey: '', quantityOnHand: 5, quantityReserved: 5, quantityAvailable: 0 },
];

test('plan: receiptNeeded = max(0, target − available) y combos sin fila cuentan como 0', () => {
  const { rows } = buildReceiptPlan(COMBOS, INVENTORY, 10);

  const a = rows.find((r) => r.productSlug === 'a')!;
  const b = rows.find((r) => r.productSlug === 'b')!;
  const c = rows.find((r) => r.productSlug === 'c')!;
  const d = rows.find((r) => r.productSlug === 'd')!;

  assert.deepEqual(
    { onHand: a.currentOnHand, reserved: a.currentReserved, available: a.currentAvailable, needed: a.receiptNeeded, hasRow: a.hasInventoryRow },
    { onHand: 10, reserved: 6, available: 4, needed: 6, hasRow: true },
  );
  assert.equal(b.receiptNeeded, 0, 'por encima del objetivo → 0');
  assert.deepEqual(
    { onHand: c.currentOnHand, reserved: c.currentReserved, available: c.currentAvailable, needed: c.receiptNeeded, hasRow: c.hasInventoryRow },
    { onHand: 0, reserved: 0, available: 0, needed: 10, hasRow: false },
    'sin fila en inventory → 0/0/0 y faltan target',
  );
  assert.equal(d.currentAvailable, 0);
  assert.equal(d.receiptNeeded, 10, 'reserved alto deja available 0 → faltan 10');
});

test('plan: resumen (combinaciones, a recibir, ya con stock, unidades totales)', () => {
  const { summary } = buildReceiptPlan(COMBOS, INVENTORY, 10);

  assert.deepEqual(summary, {
    products: 4,
    combinations: 4,
    needReceipt: 3,
    alreadyAtTarget: 1,
    withoutInventoryRow: 1,
    withStock: 2,
    totalUnitsToReceive: 26, // 6 + 0 + 10 + 10
  });
});

test('plan: target 0 no pide nada', () => {
  const { rows, summary } = buildReceiptPlan(COMBOS, INVENTORY, 0);
  assert.ok(rows.every((row) => row.receiptNeeded === 0));
  assert.equal(summary.totalUnitsToReceive, 0);
});

// =============================================================================
//  3. RUTA — read-only y candados
// =============================================================================

test('ruta receipt-plan: exige x-admin-token (401)', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    const response = await receiptPlanRoute(
      new NextRequest('http://localhost/api/admin/inventory/receipt-plan?target=10') as unknown as PlanRequest,
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'admin_unauthorized');
  });
});

test('ruta receipt-plan: target inválido se rechaza (400) sin tocar la base', async () => {
  await withEnv({ ADMIN_API_SECRET: ADMIN_SECRET }, async () => {
    for (const value of ['-1', '1.5', 'x', '999999']) {
      const response = await receiptPlanRoute(
        new NextRequest(`http://localhost/api/admin/inventory/receipt-plan?target=${value}`, {
          headers: { 'x-admin-token': ADMIN_SECRET },
        }) as unknown as PlanRequest,
      );
      assert.equal(response.status, 400, `target rechazado: ${value}`);
      assert.equal((await response.json()).code, 'invalid_target');
    }
  });
});
