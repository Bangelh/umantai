/**
 * lib/store-catalog.server.ts — catálogo vendible de UNA tienda.
 *
 * Toda función privada exige membresía (`requireStoreAccess`) antes de leer o
 * escribir. Las consultas incluyen `store_id` en el WHERE aunque el portero ya
 * haya validado: defensa en profundidad.
 *
 * El inventario NO se escribe con UPDATE: sigue pasando por
 * `inventory_apply_movement()` (ledger append-only). Las variantes comparten
 * `variant_key` con `inventory`, por eso el stock de una talla/color no se
 * mezcla con el de otra.
 */

import {
  CatalogError,
  buildOptionSchema,
  effectiveVariantPriceCents,
  normalizeVariantOptionValues,
  normalizeVariantSet,
  variantKeyFromOptionValues,
  type CatalogVariantInput,
} from './catalog';
import type { CreateOrderLineInput, ProductVariant } from './commerce';
import { normalizeVariantSelection } from './commerce';
import {
  getPlatformSql,
  requirePlatformSql,
  toIsoString,
  toNumber,
} from './platform-db.server';
import { requireStoreAccess, toStore, type Store } from './stores.server';
import { normalizeStoreSlug } from './tenancy';

type Row = Record<string, unknown>;

export interface StoreProductInput {
  name?: string | null;
  slug?: string | null;
  masterProductId?: string | null;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  priceCents: number;
  currency?: string | null;
  unit?: string | null;
  visible?: boolean;
  initialStock?: number;
  variants?: CatalogVariantInput[];
}

export interface VariantRow extends Record<string, unknown> {
  id: string;
  sku: string;
  variant_key: string;
  option_values: Record<string, string>;
  price_cents: number | null;
  is_active: boolean;
  available: number;
}

function clean(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === '23505';
}

async function storeSkuSet(storeId: string): Promise<Set<string>> {
  const sql = requirePlatformSql();
  const rows = await sql`
    SELECT sku FROM product_variants WHERE store_id = ${storeId}::uuid
  `;
  return new Set((rows as Row[]).map((row) => String(row.sku)));
}

async function getMasterForStore(masterProductId: string | null | undefined): Promise<Row | null> {
  if (!masterProductId) return null;
  const sql = requirePlatformSql();
  const rows = await sql`
    SELECT * FROM master_products
     WHERE id = ${masterProductId}::uuid AND active = TRUE AND archived_at IS NULL
     LIMIT 1
  `;
  return (rows[0] as Row | undefined) ?? null;
}

/**
 * Crea un StoreProduct (propio o desde maestro) con variantes y stock inicial.
 * La tienda y el producto viven en una transacción: si el stock inicial falla,
 * no queda un producto a medio crear.
 */
export async function createStoreProductCatalog(
  userId: string,
  storeId: string,
  input: StoreProductInput,
): Promise<Row> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  const master = await getMasterForStore(input.masterProductId ?? null);
  const name =
    clean(input.name, 160) ??
    (master ? clean(master.name, 160) : null) ??
    '';
  if (!name) throw new CatalogError('invalid_product', 'El nombre del producto es obligatorio.');

  const priceCents = Math.round(Number(input.priceCents));
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new CatalogError('invalid_product', 'El precio debe ser un entero de centavos >= 0.');
  }

  const slug = slugify(input.slug || name) || `producto-${Date.now()}`;
  const brand = clean(input.brand, 80) ?? (master ? clean(master.brand, 80) : null);
  const category = clean(input.category, 80) ?? (master ? clean(master.category, 80) : null);
  const description =
    clean(input.description, 4000) ?? (master ? clean(master.description, 4000) : null);
  const imageUrl = clean(input.imageUrl, 500) ?? (master ? clean(master.image_url, 500) : null);
  const unit = clean(input.unit, 20) ?? 'unidad';
  const currency = (/^[A-Z]{3}$/.test(String(input.currency ?? 'PEN')) ? String(input.currency ?? 'PEN') : 'PEN');
  const visible = input.visible !== false;

  const { variants, schema } = normalizeVariantSet(
    input.variants ?? [],
    slug,
    await storeSkuSet(storeId),
  );

  const initialStock = Math.max(0, Math.floor(Number(input.initialStock ?? 0)));
  if (variants.length === 0 && initialStock > 0) {
    // Producto sin ejes: stock en variant_key ''.
  }

  const statements = [
    sql`
      INSERT INTO store_products (
        store_id, master_product_id, slug, name, brand, category, description,
        image_url, price_cents, currency, unit, visible, option_schema
      ) VALUES (
        ${storeId}::uuid, ${input.masterProductId ?? null}::uuid, ${slug}, ${name},
        ${brand}, ${category}, ${description}, ${imageUrl}, ${priceCents}, ${currency},
        ${unit}, ${visible}, ${JSON.stringify(schema)}::jsonb
      )
      RETURNING id
    `,
    ...variants.map(
      (variant) => sql`
        INSERT INTO product_variants (
          store_id, store_product_id, variant_key, sku, option_values, price_cents
        )
        SELECT ${storeId}::uuid, sp.id, ${variant.variantKey}, ${variant.sku},
               ${JSON.stringify(variant.optionValues)}::jsonb, ${variant.priceCents}
          FROM store_products sp
         WHERE sp.store_id = ${storeId}::uuid AND sp.slug = ${slug}
      `,
    ),
    ...variants
      .filter((variant) => variant.initialStock > 0)
      .map(
        (variant) => sql`
          SELECT inventory_apply_movement(
            ${slug}, ${variant.variantKey}, 'receipt'::inventory_movement_type,
            ${variant.initialStock}, 0, 'MAIN', NULL, NULL,
            'initial_stock', ${`merchant:${userId}`},
            ${`initial:${storeId}:${slug}:${variant.variantKey}`}, ${storeId}::uuid
          )
        `,
      ),
    ...(variants.length === 0 && initialStock > 0
      ? [
          sql`
            SELECT inventory_apply_movement(
              ${slug}, '', 'receipt'::inventory_movement_type,
              ${initialStock}, 0, 'MAIN', NULL, NULL,
              'initial_stock', ${`merchant:${userId}`},
              ${`initial:${storeId}:${slug}`}, ${storeId}::uuid
            )
          `,
        ]
      : []),
  ];

  let productId = '';
  try {
    const results = await sql.transaction(statements);
    productId = String((results[0]?.[0] as Row | undefined)?.id ?? '');
  } catch (error) {
    if (isUniqueViolation(error)) {
      const text = String((error as Error).message ?? '');
      if (
        text.includes('product_variants_store_sku_unique') ||
        text.includes('product_variants_product_key_unique')
      ) {
        throw new CatalogError(
          'variant_sku_taken',
          'Ese SKU o combinación de opciones ya existe en la tienda.',
          409,
        );
      }
      throw new CatalogError(
        'store_product_slug_taken',
        'Ya existe un producto con ese identificador en tu tienda.',
        409,
      );
    }
    throw error;
  }

  const rows = await sql`
    SELECT sp.* FROM store_products sp
     WHERE sp.id = ${productId}::uuid AND sp.store_id = ${storeId}::uuid
     LIMIT 1
  `;
  if (!rows[0]) throw new CatalogError('store_product_not_found', 'Producto no encontrado.', 404);
  return rows[0] as Row;
}

export async function updateStoreProductCatalog(
  userId: string,
  storeId: string,
  productId: string,
  patch: {
    name?: string | null;
    brand?: string | null;
    category?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    priceCents?: number | null;
    unit?: string | null;
    visible?: boolean | null;
    archived?: boolean;
  },
): Promise<Row> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  if (patch.priceCents !== undefined && patch.priceCents !== null) {
    if (!Number.isInteger(patch.priceCents) || patch.priceCents < 0) {
      throw new CatalogError('invalid_product', 'El precio debe ser un entero de centavos >= 0.');
    }
  }

  const rows = await sql`
    UPDATE store_products
       SET name = COALESCE(${clean(patch.name, 160)}, name),
           brand = COALESCE(${clean(patch.brand, 80)}, brand),
           category = COALESCE(${clean(patch.category, 80)}, category),
           description = COALESCE(${clean(patch.description, 4000)}, description),
           image_url = COALESCE(${clean(patch.imageUrl, 500)}, image_url),
           price_cents = COALESCE(${patch.priceCents ?? null}, price_cents),
           unit = COALESCE(${clean(patch.unit, 20)}, unit),
           visible = COALESCE(${patch.visible ?? null}, visible),
           archived_at = CASE WHEN ${patch.archived === true} THEN COALESCE(archived_at, NOW()) ELSE archived_at END,
           updated_at = NOW()
     WHERE id = ${productId}::uuid AND store_id = ${storeId}::uuid
     RETURNING *
  `;
  const row = rows[0] as Row | undefined;
  if (!row) throw new CatalogError('store_product_not_found', 'Producto no encontrado.', 404);
  return row;
}

/** Agrega una variante y, si se indica, su stock inicial. Nunca toca otra tienda. */
export async function addStoreVariant(
  userId: string,
  storeId: string,
  productId: string,
  input: CatalogVariantInput,
): Promise<Row> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  const productRows = await sql`
    SELECT id, slug, name FROM store_products
     WHERE id = ${productId}::uuid AND store_id = ${storeId}::uuid AND archived_at IS NULL
     LIMIT 1
  `;
  const product = productRows[0] as Row | undefined;
  if (!product) throw new CatalogError('store_product_not_found', 'Producto no encontrado.', 404);

  const existingRows = await sql`
    SELECT variant_key, sku, option_values, price_cents, is_active
      FROM product_variants
     WHERE store_product_id = ${productId}::uuid AND archived_at IS NULL
  `;
  const existing = existingRows as Row[];
  if (existing.length > 0) {
    const existingAxes = new Set<string>();
    for (const row of existing) {
      for (const key of Object.keys((row.option_values as Record<string, string>) ?? {})) {
        existingAxes.add(key);
      }
    }
    const nextAxes = Object.keys(normalizeVariantOptionValues(input.optionValues)).sort();
    if (nextAxes.join('|') !== [...existingAxes].sort().join('|')) {
      throw new CatalogError(
        'invalid_variant',
        'La nueva variante debe usar los mismos ejes que las existentes.',
      );
    }
  }

  const allSkus = await storeSkuSet(storeId);
  for (const row of existing) allSkus.delete(String(row.sku));
  const normalized = normalizeVariantSet(
    [input],
    String(product.slug),
    allSkus,
  ).variants[0];
  if (!normalized) throw new CatalogError('invalid_variant', 'Variante inválida.');

  const schema = buildOptionSchema([
    ...existing.map((row) => ({ optionValues: (row.option_values as Record<string, string>) ?? {} })),
    { optionValues: normalized.optionValues },
  ]);

  const statements = [
    sql`
      INSERT INTO product_variants (
        store_id, store_product_id, variant_key, sku, option_values, price_cents
      ) VALUES (
        ${storeId}::uuid, ${productId}::uuid, ${normalized.variantKey}, ${normalized.sku},
        ${JSON.stringify(normalized.optionValues)}::jsonb, ${normalized.priceCents}
      )
      RETURNING *
    `,
    sql`
      UPDATE store_products
         SET option_schema = ${JSON.stringify(schema)}::jsonb, updated_at = NOW()
       WHERE id = ${productId}::uuid AND store_id = ${storeId}::uuid
    `,
  ];
  if (normalized.initialStock > 0) {
    statements.push(sql`
      SELECT inventory_apply_movement(
        ${String(product.slug)}, ${normalized.variantKey}, 'receipt'::inventory_movement_type,
        ${normalized.initialStock}, 0, 'MAIN', NULL, NULL,
        'initial_stock', ${`merchant:${userId}`},
        ${`initial:${storeId}:${productId}:${normalized.variantKey}`}, ${storeId}::uuid
      )
    `);
  }

  try {
    const results = await sql.transaction(statements);
    return (results[0]?.[0] as Row) ?? {};
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogError('variant_sku_taken', 'Ese SKU o combinación ya existe en la tienda.', 409);
    }
    throw error;
  }
}

export async function updateStoreVariant(
  userId: string,
  storeId: string,
  productId: string,
  variantId: string,
  patch: { sku?: string | null; priceCents?: number | null; active?: boolean | null; archived?: boolean },
): Promise<Row> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  if (patch.priceCents !== undefined && patch.priceCents !== null) {
    if (!Number.isInteger(patch.priceCents) || patch.priceCents < 0) {
      throw new CatalogError('invalid_variant', 'El precio debe ser un entero >= 0.');
    }
  }

  const setPrice = patch.priceCents !== undefined;
  const priceValue = patch.priceCents ?? null;
  const rows = await sql`
    UPDATE product_variants
       SET sku = COALESCE(${clean(patch.sku, 80)}, sku),
           price_cents = CASE WHEN ${setPrice} THEN ${priceValue} ELSE price_cents END,
           is_active = COALESCE(${patch.active ?? null}, is_active),
           archived_at = CASE WHEN ${patch.archived === true} THEN COALESCE(archived_at, NOW()) ELSE archived_at END,
           updated_at = NOW()
     WHERE id = ${variantId}::uuid
       AND store_product_id = ${productId}::uuid
       AND store_id = ${storeId}::uuid
     RETURNING *
  `;
  const row = rows[0] as Row | undefined;
  if (!row) throw new CatalogError('variant_not_found', 'Variante no encontrada.', 404);

  if (patch.archived === true) {
    await sql`
      UPDATE store_products
         SET option_schema = (
           SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('name', key, 'values', values)), '[]'::jsonb)
             FROM (
               SELECT key, jsonb_agg(DISTINCT value) AS values
                 FROM product_variants v,
                      LATERAL jsonb_each_text(v.option_values)
                WHERE v.store_product_id = ${productId}::uuid
                  AND v.store_id = ${storeId}::uuid
                  AND v.archived_at IS NULL
                  AND v.is_active
                GROUP BY key
             ) axes
         ),
             updated_at = NOW()
       WHERE id = ${productId}::uuid AND store_id = ${storeId}::uuid
    `;
  }

  return row;
}

export async function adjustStoreVariantStock(
  userId: string,
  storeId: string,
  productId: string,
  variantKey: string,
  delta: number,
  reason: string,
): Promise<{ onHand: number; reserved: number; available: number }> {
  await requireStoreAccess(userId, storeId);
  if (!Number.isInteger(delta) || delta === 0) {
    throw new CatalogError('invalid_stock_delta', 'El ajuste debe ser un entero distinto de 0.');
  }
  const cleanReason = clean(reason, 200);
  if (!cleanReason || cleanReason.length < 3) {
    throw new CatalogError('invalid_stock_delta', 'Explica el motivo del ajuste (mín. 3 caracteres).');
  }

  const sql = requirePlatformSql();
  const productRows = await sql`
    SELECT sp.slug,
           COALESCE((
             SELECT SUM(i.quantity_on_hand)::int
               FROM inventory i
              WHERE i.store_id = sp.store_id AND i.product_slug = sp.slug
                AND i.variant_key = ${variantKey} AND i.is_active
           ), 0) AS on_hand
      FROM store_products sp
     WHERE sp.id = ${productId}::uuid AND sp.store_id = ${storeId}::uuid
     LIMIT 1
  `;
  const product = productRows[0] as Row | undefined;
  if (!product) throw new CatalogError('store_product_not_found', 'Producto no encontrado.', 404);

  if (variantKey !== '') {
    const variantRows = await sql`
      SELECT 1 FROM product_variants
       WHERE store_product_id = ${productId}::uuid
         AND store_id = ${storeId}::uuid
         AND variant_key = ${variantKey}
         AND archived_at IS NULL
       LIMIT 1
    `;
    if (!variantRows[0]) throw new CatalogError('variant_not_found', 'Variante no encontrada.', 404);
  }

  try {
    await sql`
      SELECT inventory_apply_movement(
        ${String(product.slug)}, ${variantKey}, 'adjustment'::inventory_movement_type,
        ${delta}, 0, 'MAIN', NULL, NULL,
        ${cleanReason}, ${`merchant:${userId}`},
        ${`adjust:${storeId}:${productId}:${variantKey}:${Date.now()}:${delta}`}, ${storeId}::uuid
      )
    `;
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23514') {
      throw new CatalogError(
        'insufficient_stock',
        'El ajuste deja stock negativo o por debajo de lo reservado.',
        409,
      );
    }
    throw error;
  }

  const rows = await sql`
    SELECT COALESCE(SUM(quantity_on_hand), 0)::int AS on_hand,
           COALESCE(SUM(quantity_reserved), 0)::int AS reserved,
           COALESCE(SUM(quantity_available), 0)::int AS available
      FROM inventory
     WHERE store_id = ${storeId}::uuid AND product_slug = ${String(product.slug)}
       AND variant_key = ${variantKey} AND is_active
  `;
  const row = rows[0] as Row | undefined;
  return {
    onHand: toNumber(row?.on_hand),
    reserved: toNumber(row?.reserved),
    available: toNumber(row?.available),
  };
}

// =============================================================================
//  CHECKOUT: LA TIENDA SE DERIVA DE LOS PRODUCTOS
// =============================================================================

export interface CheckoutRequestLine {
  productSlug: string;
  storeSlug?: string | null;
  quantity: number;
  variant?: Record<string, unknown>;
}

export interface ResolvedStoreCheckout {
  store: Store;
  lines: CreateOrderLineInput[];
}

/**
 * Resuelve una compra de UNA tienda.
 *
 * - `storeSlug` es solo un localizador: la tienda real se lee de `stores` y el
 *   `store_id` del pedido sale de esa fila, nunca de un ID del navegador.
 * - Todos los productos se resuelven dentro de esa tienda. Si una línea apunta
 *   a otra, se rechaza con `mixed_store_cart`.
 * - El precio y la variante se leen de `store_products`/`product_variants`.
 * - Un producto no publicado o archivado no se puede comprar.
 */
export async function resolveStoreCheckout(
  storeSlugHint: string | null,
  rawLines: readonly CheckoutRequestLine[],
): Promise<ResolvedStoreCheckout> {
  const sql = requirePlatformSql();
  if (rawLines.length === 0) {
    throw new CatalogError('empty_cart', 'El carrito está vacío.', 400);
  }

  const lineHints = [
    ...new Set(
      rawLines
        .map((line) => (line.storeSlug ? normalizeStoreSlug(line.storeSlug) : ''))
        .filter(Boolean),
    ),
  ];
  if (lineHints.length > 1) {
    throw new CatalogError('mixed_store_cart', 'Un pedido no puede mezclar tiendas.', 409);
  }

  const slug = normalizeStoreSlug(storeSlugHint ?? lineHints[0] ?? '');
  if (lineHints.length === 1 && slug && lineHints[0] !== slug) {
    throw new CatalogError(
      'mixed_store_cart',
      'El pedido declara una tienda distinta a la de sus productos.',
      409,
    );
  }
  if (!slug) {
    throw new CatalogError(
      'store_required',
      'El pedido necesita una tienda; no se acepta un store_id sin resolver.',
      400,
    );
  }

  const storeRows = await sql`
    SELECT * FROM stores
     WHERE lower(slug) = lower(${slug}) AND active = TRUE
     LIMIT 1
  `;
  const storeRow = storeRows[0] as Row | undefined;
  if (!storeRow) {
    throw new CatalogError('store_inactive', 'La tienda no está activa o no existe.', 409);
  }
  const store = toStore(storeRow);

  const slugs = [...new Set(rawLines.map((line) => line.productSlug))];
  const productRows = await sql`
    SELECT sp.*
      FROM store_products sp
     WHERE sp.store_id = ${String(storeRow.id)}::uuid
       AND sp.slug = ANY(${slugs}::text[])
       AND sp.visible = TRUE
       AND sp.archived_at IS NULL
  `;
  const products = new Map<string, Row>();
  for (const row of productRows as Row[]) products.set(String(row.slug), row);

  const productIds = [...products.values()].map((row) => String(row.id));
  const variantRows = productIds.length
    ? await sql`
        SELECT v.*, COALESCE((
                 SELECT SUM(i.quantity_available)::int
                   FROM inventory i
                  WHERE i.store_id = v.store_id AND i.product_slug = sp.slug
                    AND i.variant_key = v.variant_key AND i.is_active
               ), 0) AS available
          FROM product_variants v
          JOIN store_products sp ON sp.id = v.store_product_id
         WHERE v.store_product_id = ANY(${productIds}::uuid[])
           AND v.archived_at IS NULL
           AND v.is_active
         ORDER BY v.variant_key
      `
    : [];
  const variantsByProduct = new Map<string, Row[]>();
  for (const row of variantRows as Row[]) {
    const key = String(row.store_product_id);
    const bucket = variantsByProduct.get(key) ?? [];
    bucket.push(row);
    variantsByProduct.set(key, bucket);
  }

  const lines: CreateOrderLineInput[] = [];
  for (const rawLine of rawLines) {
    const product = products.get(rawLine.productSlug);
    if (!product) {
      throw new CatalogError(
        'product_not_available',
        `El producto "${rawLine.productSlug}" no está publicado en esta tienda.`,
        409,
      );
    }

    const variants = variantsByProduct.get(String(product.id)) ?? [];
    const selection = normalizeVariantSelection(
      rawLine.variant as ProductVariant | undefined,
    ) as Record<string, string>;
    const variantKey = variantKeyFromOptionValues(selection);
    let variant: Row | null = null;

    if (variants.length > 0) {
      variant = variants.find((row) => String(row.variant_key) === variantKey) ?? null;
      if (!variant) {
        throw new CatalogError(
          'invalid_variant',
          `La variante seleccionada de "${String(product.name)}" no existe.`,
          400,
        );
      }
    } else if (variantKey !== '') {
      throw new CatalogError(
        'invalid_variant',
        `"${String(product.name)}" no tiene variantes.`,
        400,
      );
    }

    const quantity = Number(rawLine.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new CatalogError('invalid_quantity', 'La cantidad debe ser un entero entre 1 y 99.', 400);
    }

    const basePrice = toNumber(product.price_cents);
    const unitPriceCents = effectiveVariantPriceCents(
      basePrice,
      variant && variant.price_cents !== null ? toNumber(variant.price_cents) : null,
    );

    lines.push({
      productSlug: String(product.slug),
      productName: String(product.name),
      productBrand: (product.brand as string | null) ?? null,
      imageUrl: (product.image_url as string | null) ?? null,
      variant: variant
        ? (normalizeVariantSelection(
            variant.option_values as ProductVariant,
          ) as Record<string, string>)
        : {},
      variantKey,
      variantSku: variant ? String(variant.sku) : null,
      quantity,
      unitPrice: unitPriceCents / 100,
    });
  }

  return { store, lines };
}

export async function countStorePublishedProducts(userId: string, storeId: string): Promise<number> {
  await requireStoreAccess(userId, storeId);
  const sql = getPlatformSql();
  if (!sql) return 0;
  const rows = await sql`
    SELECT COUNT(*)::int AS total
      FROM store_products
     WHERE store_id = ${storeId}::uuid AND visible = TRUE AND archived_at IS NULL
  `;
  return toNumber((rows[0] as Row | undefined)?.total);
}

export function productUpdatedAt(row: Row): string {
  return toIsoString(row.updated_at);
}
