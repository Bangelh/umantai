/**
 * lib/catalog.ts — contrato puro del catálogo multi-tienda.
 *
 * No toca la base de datos. Lo comparten:
 *   · el buscador y el catálogo público,
 *   · el panel del comerciante,
 *   · el administrador de catálogo maestro,
 *   · el checkout (validación de variante y snapshot).
 *
 * El catálogo maestro NO asume ningún rubro: categoría, marca, atributos y ejes
 * de variación son texto/JSON genéricos. Los ejes (`talla`, `color`, `peso`,
 * `ancho`…) no son columnas: viven en `option_schema` y `product_variants`.
 */

import { buildVariantKey } from './commerce';

export const MAX_VARIANTS_PER_PRODUCT = 100;
export const MAX_OPTION_AXES = 4;
export const MAX_OPTION_VALUES = 20;
export const MAX_OPTION_NAME = 30;
export const MAX_OPTION_VALUE = 60;

/** Espejo en JS de `normalize_search_text()` (migración 016). */
export function normalizeSearchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ProductOptionSchema {
  name: string;
  values: string[];
}

export interface CatalogVariant {
  id: string;
  sku: string;
  variantKey: string;
  optionValues: Record<string, string>;
  /** NULL = usa el precio del StoreProduct. */
  priceCents: number | null;
  available: number;
  inStock: boolean;
  active: boolean;
}

export interface MasterProduct {
  id: string;
  slug: string;
  name: string;
  normalizedName: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  attributes: Record<string, unknown>;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogVariantInput {
  /** `{ talla: 'M', color: 'negro' }` */
  optionValues: Record<string, unknown>;
  sku?: string | null;
  /** NULL = precio del producto. */
  priceCents?: number | null;
  initialStock?: number;
  active?: boolean;
}

export type NormalizedVariantInput = {
  optionValues: Record<string, string>;
  variantKey: string;
  sku: string;
  priceCents: number | null;
  initialStock: number;
  active: boolean;
};

export class CatalogError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.status = status;
  }
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

/**
 * Normaliza los valores de una variante. No valida contra el esquema: eso lo
 * hace `normalizeVariantSet`, que ve todas las combinaciones a la vez.
 */
export function normalizeVariantOptionValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const values: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = cleanText(rawKey, MAX_OPTION_NAME).toLowerCase();
    const value = cleanText(rawValue, MAX_OPTION_VALUE);
    if (!key || !value) continue;
    values[key] = value;
  }
  return values;
}

/** `variant_key` canónico: `color:negro|talla:m`. */
export function variantKeyFromOptionValues(optionValues: Record<string, string>): string {
  return buildVariantKey(normalizeVariantOptionValues(optionValues));
}

export function variantLabel(optionValues: Record<string, string>): string {
  return Object.values(optionValues).filter(Boolean).join(' · ');
}

function slugToken(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

/** SKU legible y estable a partir del slug del producto + valores de opción. */
export function generateSku(productSlug: string, optionValues: Record<string, string>): string {
  const parts = Object.values(optionValues).map(slugToken).filter(Boolean);
  return [slugToken(productSlug), ...parts].filter(Boolean).join('-').slice(0, 72) || 'sku';
}

function uniqueSku(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`.slice(0, 80);
    if (!taken.has(candidate)) return candidate;
  }
  throw new CatalogError('variant_sku_taken', 'No se pudo generar un SKU único.');
}

/**
 * Valida un conjunto de variantes:
 *   · todas comparten exactamente los mismos ejes;
 *   · no hay combinaciones repetidas;
 *   · cada `variant_key` es estable y no vacío;
 *   · los SKU son únicos dentro del producto.
 */
export function normalizeVariantSet(
  input: readonly CatalogVariantInput[],
  productSlug: string,
  existingSkus: Iterable<string> = [],
): { variants: NormalizedVariantInput[]; schema: ProductOptionSchema[] } {
  if (input.length === 0) return { variants: [], schema: [] };
  if (input.length > MAX_VARIANTS_PER_PRODUCT) {
    throw new CatalogError(
      'too_many_variants',
      `Un producto admite hasta ${MAX_VARIANTS_PER_PRODUCT} variantes.`,
    );
  }

  const normalized = input.map((variant) => ({
    optionValues: normalizeVariantOptionValues(variant.optionValues),
    sku: cleanText(variant.sku ?? '', 80),
    priceCents:
      variant.priceCents === null || variant.priceCents === undefined
        ? null
        : Math.round(Number(variant.priceCents)),
    initialStock: Math.max(0, Math.floor(Number(variant.initialStock ?? 0))),
    active: variant.active !== false,
  }));

  for (const variant of normalized) {
    const axes = Object.keys(variant.optionValues);
    if (axes.length === 0) {
      throw new CatalogError('invalid_variant', 'Cada variante necesita al menos un eje (ej. talla).');
    }
    if (axes.length > MAX_OPTION_AXES) {
      throw new CatalogError('invalid_variant', `Máximo ${MAX_OPTION_AXES} ejes por variante.`);
    }
    for (const [key, value] of Object.entries(variant.optionValues)) {
      if (!key || key.length > MAX_OPTION_NAME || value.length > MAX_OPTION_VALUE) {
        throw new CatalogError('invalid_variant', 'Nombre o valor de opción inválido.');
      }
    }
    if (
      variant.priceCents !== null &&
      (!Number.isInteger(variant.priceCents) || variant.priceCents < 0)
    ) {
      throw new CatalogError('invalid_variant', 'El precio de la variante debe ser un entero >= 0.');
    }
  }

  const axes = Object.keys(normalized[0].optionValues).sort();
  const seenKeys = new Set<string>();
  const takenSkus = new Set(Array.from(existingSkus));

  const variants: NormalizedVariantInput[] = normalized.map((variant) => {
    const variantAxes = Object.keys(variant.optionValues).sort();
    if (variantAxes.join('|') !== axes.join('|')) {
      throw new CatalogError(
        'invalid_variant',
        'Todas las variantes deben usar los mismos ejes (ej. todas talla+color o todas talla).',
      );
    }

    const variantKey = variantKeyFromOptionValues(variant.optionValues);
    if (!variantKey) throw new CatalogError('invalid_variant', 'La variante no tiene valores.');
    if (seenKeys.has(variantKey)) {
      throw new CatalogError('duplicate_variant', 'Esa combinación de opciones está repetida.');
    }
    seenKeys.add(variantKey);

    const sku = uniqueSku(variant.sku || generateSku(productSlug, variant.optionValues), takenSkus);
    takenSkus.add(sku);

    return {
      optionValues: variant.optionValues,
      variantKey,
      sku,
      priceCents: variant.priceCents,
      initialStock: variant.initialStock,
      active: variant.active,
    };
  });

  return { variants, schema: buildOptionSchema(variants) };
}

/** Esquema de opciones derivado de las variantes (orden de aparición). */
export function buildOptionSchema(
  variants: readonly { optionValues: Record<string, string> }[],
): ProductOptionSchema[] {
  const schema = new Map<string, string[]>();
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.optionValues)) {
      const values = schema.get(key) ?? [];
      if (!values.includes(value) && values.length < MAX_OPTION_VALUES) values.push(value);
      schema.set(key, values);
    }
  }
  return [...schema.entries()].map(([name, values]) => ({ name, values }));
}

/** Normaliza el `option_schema` persistido (JSONB) para la UI. */
export function parseOptionSchema(value: unknown): ProductOptionSchema[] {
  if (!Array.isArray(value)) return [];
  const schema: ProductOptionSchema[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const name = cleanText((item as { name?: unknown }).name, MAX_OPTION_NAME).toLowerCase();
    const rawValues = (item as { values?: unknown }).values;
    if (!name || !Array.isArray(rawValues)) continue;
    const values = rawValues
      .map((entry) => cleanText(entry, MAX_OPTION_VALUE))
      .filter(Boolean)
      .slice(0, MAX_OPTION_VALUES);
    if (values.length > 0) schema.push({ name, values });
  }
  return schema;
}

/**
 * Devuelve la variante que corresponde a una selección del cliente.
 * El checkout usa esta misma función: una selección inventada no puede
 * convertirse en una línea de pedido.
 */
export function findVariantBySelection<T extends { variantKey: string }>(
  variants: readonly T[],
  selection: Record<string, string>,
): T | null {
  const key = variantKeyFromOptionValues(selection);
  if (!key) return variants.length === 0 ? null : null;
  return variants.find((variant) => variant.variantKey === key) ?? null;
}

/**
 * Precio efectivo de una variante. El servidor nunca confía en el precio del
 * navegador: si la variante no tiene override, usa el precio del producto.
 */
export function effectiveVariantPriceCents(
  basePriceCents: number,
  variantPriceCents: number | null | undefined,
): number {
  return variantPriceCents === null || variantPriceCents === undefined
    ? basePriceCents
    : variantPriceCents;
}

/** Para el editor: convierte "talla: S, M, L" en `{talla:['S','M','L']}`. */
export function parseVariantAxesInput(raw: string): ProductOptionSchema[] {
  const axes: ProductOptionSchema[] = [];
  for (const line of raw.split(/\n|;/)) {
    const [rawName, rawValues] = line.split(':');
    const name = cleanText(rawName, MAX_OPTION_NAME).toLowerCase();
    if (!name || !rawValues) continue;
    const values = rawValues
      .split(',')
      .map((value) => cleanText(value, MAX_OPTION_VALUE))
      .filter(Boolean);
    if (values.length > 0) axes.push({ name, values: [...new Set(values)] });
  }
  return axes;
}

/** Producto cartesiano de ejes (para generar combinaciones en el editor). */
export function cartesianVariants(schema: readonly ProductOptionSchema[]): Array<Record<string, string>> {
  if (schema.length === 0) return [];
  let combinations: Array<Record<string, string>> = [{}];
  for (const axis of schema) {
    const next: Array<Record<string, string>> = [];
    for (const combination of combinations) {
      for (const value of axis.values) {
        next.push({ ...combination, [axis.name]: value });
      }
      if (next.length > MAX_VARIANTS_PER_PRODUCT) {
        throw new CatalogError(
          'too_many_variants',
          `El producto supera ${MAX_VARIANTS_PER_PRODUCT} combinaciones.`,
        );
      }
    }
    combinations = next;
  }
  return combinations;
}
