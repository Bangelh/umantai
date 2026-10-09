/**
 * lib/inventory-receipt-plan.ts — plan de reposición READ-ONLY (puro, sin DB ni red).
 *
 * Cruza TODAS las combinaciones activas del catálogo (`lib/products.ts`) contra las
 * filas reales de `inventory`, y calcula cuántas unidades hay que recibir para dejar
 * cada SKU en el objetivo (`quantityAvailable = target`).
 *
 * ─── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
 * `GET /api/admin/inventory` solo devuelve filas que YA existen en `inventory`. Para
 * preparar stock hay que ver también las combinaciones del catálogo SIN fila (les
 * faltan `target` unidades). Ese cruce lo resuelve este módulo.
 *
 * NO escribe nada y NO toca `reserved`: solo calcula `max(0, target - available)`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { enumerateVariantKeys } from './commerce';
import { getProductOptions, type Product } from './products';

export interface CatalogCombination {
  productSlug: string;
  productName: string;
  variantKey: string;
}

/** Snapshot mínimo de una fila de `inventory` necesario para el plan. */
export interface InventorySnapshotRow {
  productSlug: string;
  variantKey: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
}

export interface ReceiptPlanRow {
  productSlug: string;
  productName: string;
  variantKey: string;
  currentOnHand: number;
  currentReserved: number;
  currentAvailable: number;
  /** `max(0, target - currentAvailable)`. */
  receiptNeeded: number;
  /** ¿Existe fila en `inventory` para esta combinación? */
  hasInventoryRow: boolean;
}

export interface ReceiptPlanSummary {
  /** Productos distintos en el catálogo activo. */
  products: number;
  /** Combinaciones producto/variante (unidades de SKU). */
  combinations: number;
  /** Combinaciones que necesitan al menos una recepción. */
  needReceipt: number;
  /** Combinaciones ya en o por encima del objetivo (`receiptNeeded === 0`). */
  alreadyAtTarget: number;
  /** Combinaciones sin fila en `inventory`. */
  withoutInventoryRow: number;
  /** Combinaciones con stock disponible > 0 hoy. */
  withStock: number;
  /** Suma de `receiptNeeded`: unidades totales a recibir. */
  totalUnitsToReceive: number;
}

/**
 * Expande el catálogo a una fila por combinación producto/variante.
 *
 * Misma regla que `scripts/seed-inventory.ts` y `POST /api/admin/inventory`: usa
 * `getProductOptions()` (formato genérico `options` o legacy `colors`/`storage`) y
 * `enumerateVariantKeys()`; un producto sin opciones es UNA fila con `variant_key = ''`.
 */
export function enumerateCatalogCombinations(
  products: readonly Product[],
): CatalogCombination[] {
  const combinations: CatalogCombination[] = [];

  for (const product of products) {
    const keys = enumerateVariantKeys(getProductOptions(product));
    const effective = keys.length > 0 ? keys : [''];

    for (const variantKey of effective) {
      combinations.push({
        productSlug: product.slug,
        productName: product.name,
        variantKey,
      });
    }
  }

  combinations.sort(
    (a, b) =>
      a.productSlug.localeCompare(b.productSlug) || a.variantKey.localeCompare(b.variantKey),
  );
  return combinations;
}

/** Clave compuesta para cruzar catálogo y `inventory` (no colisiona con slugs/keys). */
function combinationKey(productSlug: string, variantKey: string): string {
  return `${productSlug}\u0000${variantKey}`;
}

/**
 * Cruza las combinaciones del catálogo con las filas de `inventory` y calcula el plan.
 *
 * Una combinación sin fila cuenta como `onHand 0 / reserved 0 / available 0` →
 * `receiptNeeded = target`.
 */
export function buildReceiptPlan(
  combinations: readonly CatalogCombination[],
  inventory: readonly InventorySnapshotRow[],
  target: number,
): { rows: ReceiptPlanRow[]; summary: ReceiptPlanSummary } {
  const byKey = new Map(
    inventory.map((row) => [combinationKey(row.productSlug, row.variantKey), row]),
  );

  const rows: ReceiptPlanRow[] = combinations.map((combination) => {
    const snapshot = byKey.get(combinationKey(combination.productSlug, combination.variantKey));

    const currentOnHand = snapshot ? Number(snapshot.quantityOnHand) : 0;
    const currentReserved = snapshot ? Number(snapshot.quantityReserved) : 0;
    const currentAvailable = snapshot
      ? Number(snapshot.quantityAvailable)
      : Math.max(currentOnHand - currentReserved, 0);

    return {
      productSlug: combination.productSlug,
      productName: combination.productName,
      variantKey: combination.variantKey,
      currentOnHand,
      currentReserved,
      currentAvailable,
      receiptNeeded: Math.max(0, target - currentAvailable),
      hasInventoryRow: Boolean(snapshot),
    };
  });

  const summary: ReceiptPlanSummary = {
    products: new Set(combinations.map((combination) => combination.productSlug)).size,
    combinations: combinations.length,
    needReceipt: rows.filter((row) => row.receiptNeeded > 0).length,
    alreadyAtTarget: rows.filter((row) => row.receiptNeeded === 0).length,
    withoutInventoryRow: rows.filter((row) => !row.hasInventoryRow).length,
    withStock: rows.filter((row) => row.currentAvailable > 0).length,
    totalUnitsToReceive: rows.reduce((sum, row) => sum + row.receiptNeeded, 0),
  };

  return { rows, summary };
}
