import { enumerateVariantKeys } from './commerce';
import { baseProductsData, getProductOptions, type Product } from './products';

export type CatalogVariantResolution =
  | { ok: true; product: Product }
  | { ok: false; error: string };

/**
 * Resuelve `productSlug` + `variantKey` contra el catálogo REAL.
 *
 * El admin no puede inventar un SKU ni una variante: si el producto no existe o la
 * combinación no es una de sus opciones, se rechaza antes de tocar el ledger.
 * Producto sin opciones usa `variant_key = ''`.
 */
export function resolveCatalogVariant(
  productSlug: string,
  variantKey: string,
  products: readonly Product[] = baseProductsData,
): CatalogVariantResolution {
  const product = products.find((candidate) => candidate.slug === productSlug);
  if (!product) return { ok: false, error: `Producto desconocido: "${productSlug}".` };

  const validKeys = enumerateVariantKeys(getProductOptions(product));
  if (!validKeys.includes(variantKey)) {
    return {
      ok: false,
      error: `Variante inválida para "${productSlug}": "${variantKey}".`,
    };
  }

  return { ok: true, product };
}
