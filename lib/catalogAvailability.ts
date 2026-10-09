import { variantKeyForSelection, type ProductVariant } from './commerce';
import { getProductOptions } from './products';

/**
 * lib/catalogAvailability.ts — decisión de compra a partir del inventario REAL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE ESTE ARCHIVO
 *
 *  El catálogo decidía "In stock" y el botón "Add to Cart" con `product.inStock`,
 *  que es un número de PRESENTACIÓN (datos demo y `product_overrides.inStock`).
 *  Divergía del inventario real: se podía agregar al carrito un producto con
 *  `inventory.quantity_available = 0` y el rechazo aparecía recién en el checkout
 *  (409 `insufficient_stock`).
 *
 *  Acá vive la ÚNICA regla de "¿se puede agregar?", derivada de la disponibilidad
 *  por variante (`/api/catalog/availability` ← tabla `inventory`). `inStock` NO se
 *  lee: si contradice al inventario, manda el inventario.
 *
 *  Esto es UX: el servidor sigue siendo la autoridad de la venta (la reserva
 *  transaccional de `POST /api/orders`). Este módulo NO reemplaza esa validación.
 *
 *  Al ser funciones puras (sin React ni red) se pueden probar directamente en
 *  `tests/catalog.availability.test.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** `variant_key` → unidades disponibles. Es lo que devuelve la API por producto. */
export type VariantAvailability = Record<string, number>;

/** Lo que la API devuelve por slug. */
export interface ProductAvailability {
  variants: VariantAvailability;
  totalAvailable: number;
}

/** Respuesta completa de `GET /api/catalog/availability`. */
export type ProductAvailabilityMap = Record<string, ProductAvailability>;

/** Lo que la UI debe mostrar en el botón de compra. */
export type PurchaseLabel = 'select-options' | 'checking' | 'out-of-stock' | 'add';

export interface PurchaseAvailability {
  /**
   * `variant_key` canónico de la selección actual; `null` si está incompleta.
   * Es la MISMA clave que comparten carrito, `order_items` e `inventory`.
   */
  variantKey: string | null;
  isSelectionComplete: boolean;
  /**
   * Unidades disponibles de ESA variante. `null` solo cuando todavía no hay datos
   * de inventario (carga en curso o fallo de red): desconocido, no cero.
   */
  available: number | null;
  /** Única fuente del `disabled` del botón. */
  canAdd: boolean;
  label: PurchaseLabel;
}

/**
 * Traduce (producto + disponibilidad por variante + selección) a lo que la UI
 * necesita para decidir y etiquetar el botón.
 *
 * Reglas, en orden:
 *   1. producto con opciones y selección incompleta → `select-options` (no se puede saber la variante)
 *   2. sin datos de inventario (`variants === null`) → `checking` (no se autoriza a ciegas)
 *   3. disponible <= 0 → `out-of-stock`
 *   4. disponible > 0  → `add`
 *
 * La disponibilidad es POR VARIANTE: nunca se suma entre variantes ni se usa el total
 * del producto (`totalAvailable`), porque elegir una combinación agotada es agotado.
 */
export function purchaseAvailability(
  product: { options?: unknown; colors?: unknown; storage?: unknown },
  variants: VariantAvailability | null,
  selection: ProductVariant = {},
): PurchaseAvailability {
  const options = getProductOptions(
    product as Pick<Parameters<typeof getProductOptions>[0], 'options' | 'colors' | 'storage'>,
  );
  const variantKey = variantKeyForSelection(options, selection);
  const isSelectionComplete = variantKey !== null;

  // `?? 0`: una variante sin fila en `inventory` está agotada, no "desconocida".
  // Solo la AUSENCIA de la respuesta completa es "desconocido".
  const available =
    isSelectionComplete && variants !== null ? (variants[variantKey] ?? 0) : null;

  const canAdd = available !== null && available > 0;

  const label: PurchaseLabel =
    !isSelectionComplete && options.length > 0
      ? 'select-options'
      : available === null
        ? 'checking'
        : available <= 0
          ? 'out-of-stock'
          : 'add';

  return { variantKey, isSelectionComplete, available, canAdd, label };
}

/** Disponibilidad por variante de UN producto dentro de la respuesta de la API. */
export function variantsFor(
  availability: ProductAvailabilityMap | null,
  slug: string,
): VariantAvailability | null {
  return availability?.[slug]?.variants ?? null;
}
