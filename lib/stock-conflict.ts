/**
 * lib/stock-conflict.ts — detectar QUÉ SKU no alcanza, antes y después de reservar.
 *
 * `POST /api/orders` valida disponibilidad fresca antes de crear el pedido y, si
 * el motor igual rechaza por una carrera, vuelve a leer para explicar el conflicto.
 * Este módulo es puro: no toca la base ni confía en el stock del navegador.
 */

export interface RequestedStockLine {
  productSlug: string;
  productName?: string | null;
  variantKey: string;
  quantity: number;
}

export interface AvailabilitySnapshot {
  productSlug: string;
  variantKey: string;
  quantityAvailable: number;
}

export interface StockShortage {
  productSlug: string;
  productName: string | null;
  variantKey: string;
  requested: number;
  available: number;
}

function skuKey(productSlug: string, variantKey: string): string {
  return `${productSlug}::${variantKey}`;
}

/**
 * Compara lo que el carrito pide contra la disponibilidad REAL.
 *
 * Varias líneas del mismo SKU se suman (el motor las reserva todas). Un SKU sin
 * fila de inventario tiene disponible 0, no "infinito".
 */
export function findStockShortages(
  lines: readonly RequestedStockLine[],
  availability: readonly AvailabilitySnapshot[],
): StockShortage[] {
  const availableBySku = new Map<string, number>();
  for (const row of availability) {
    availableBySku.set(skuKey(row.productSlug, row.variantKey), row.quantityAvailable);
  }

  const requestedBySku = new Map<string, StockShortage>();
  for (const line of lines) {
    const key = skuKey(line.productSlug, line.variantKey);
    const current = requestedBySku.get(key);
    if (current) {
      current.requested += line.quantity;
      continue;
    }
    requestedBySku.set(key, {
      productSlug: line.productSlug,
      productName: line.productName ?? null,
      variantKey: line.variantKey,
      requested: line.quantity,
      available: availableBySku.get(key) ?? 0,
    });
  }

  return [...requestedBySku.values()]
    .filter((line) => line.requested > line.available)
    .map((line) => ({ ...line, available: Math.max(0, line.available) }))
    .sort((a, b) =>
      skuKey(a.productSlug, a.variantKey).localeCompare(skuKey(b.productSlug, b.variantKey)),
    );
}

export interface StockConflictResponse {
  error: string;
  code: 'insufficient_stock';
  details: { items: StockShortage[] };
}

/** Forma única del 409 de stock (la consume el carrito). */
export function buildStockConflictResponse(
  message: string,
  shortages: StockShortage[],
): StockConflictResponse {
  return {
    error: message,
    code: 'insufficient_stock',
    details: { items: shortages },
  };
}
