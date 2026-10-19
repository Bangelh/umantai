import { buildVariantKey, enumerateVariantSelections } from '@/lib/commerce';
import { baseProductsData, getProductOptions } from '@/lib/products';

export interface VariantChoice {
  key: string;
  label: string;
}

/** Productos del catálogo para los selectores del admin. */
export const catalogProducts = baseProductsData.map((product) => ({
  slug: product.slug,
  name: product.name,
  brand: product.brand,
}));

/** Combinaciones válidas de un producto. Producto simple → `[{ key: '', label }]`. */
export function variantChoicesFor(productSlug: string): VariantChoice[] {
  const product = baseProductsData.find((candidate) => candidate.slug === productSlug);
  if (!product) return [{ key: '', label: 'sin variante' }];

  const options = getProductOptions(product);
  if (options.length === 0) return [{ key: '', label: 'sin variante' }];

  return enumerateVariantSelections(options).map((selection) => ({
    key: buildVariantKey(selection),
    label: Object.values(selection).filter(Boolean).join(' · ') || 'sin variante',
  }));
}
