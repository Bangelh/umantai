/**
 * lib/master.server.ts — catálogo maestro global (Platform Admin).
 *
 * Reglas:
 *   · El maestro NO tiene precio ni stock: eso es de cada StoreProduct.
 *   · No se duplica el mismo nombre+marca (índice único en 016).
 *   · Archivar es lógico (`archived_at`): nunca se borra un producto que pudo
 *     haber sido referenciado por una tienda.
 */

import {
  CatalogError,
  normalizeSearchText,
  type MasterProduct,
  type ProductOptionSchema,
} from './catalog';
import {
  getPlatformSql,
  requirePlatformSql,
  toIsoString,
} from './platform-db.server';

type Row = Record<string, unknown>;

export interface MasterProductInput {
  name: string;
  slug?: string | null;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, unknown>;
  active?: boolean;
}

export interface MasterProductListQuery {
  q?: string;
  category?: string | null;
  brand?: string | null;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

function clean(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

function slugify(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function toMasterProduct(row: Row): MasterProduct {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    normalizedName: String(row.normalized_name ?? ''),
    brand: (row.brand as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    attributes:
      row.attributes && typeof row.attributes === 'object'
        ? (row.attributes as Record<string, unknown>)
        : {},
    active: row.active === true,
    archivedAt: row.archived_at ? toIsoString(row.archived_at) : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function listMasterProducts(
  query: MasterProductListQuery = {},
): Promise<{ products: MasterProduct[]; total: number }> {
  const sql = getPlatformSql();
  if (!sql) return { products: [], total: 0 };

  const q = normalizeSearchText(query.q ?? '');
  const like = `%${escapeLike(q)}%`;
  const category = normalizeSearchText(query.category ?? '');
  const brand = normalizeSearchText(query.brand ?? '');
  const includeArchived = query.includeArchived === true;
  const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));

  const rows = await sql`
    SELECT mp.*, COUNT(*) OVER()::int AS total
      FROM master_products mp
     WHERE (${includeArchived}::boolean OR mp.archived_at IS NULL)
       AND (${q} = '' OR mp.normalized_name LIKE ${like} ESCAPE '\\'
            OR normalize_search_text(COALESCE(mp.brand, '')) LIKE ${like} ESCAPE '\\'
            OR normalize_search_text(COALESCE(mp.category, '')) LIKE ${like} ESCAPE '\\')
       AND (${category} = '' OR normalize_search_text(COALESCE(mp.category, '')) = ${category})
       AND (${brand} = '' OR normalize_search_text(COALESCE(mp.brand, '')) = ${brand})
     ORDER BY mp.archived_at NULLS FIRST, lower(mp.name)
     LIMIT ${limit} OFFSET ${offset}
  `;

  return {
    products: (rows as Row[]).map(toMasterProduct),
    total: Number((rows[0] as Row | undefined)?.total ?? 0),
  };
}

export async function getMasterProduct(id: string): Promise<MasterProduct | null> {
  const sql = getPlatformSql();
  if (!sql) return null;
  const rows = await sql`SELECT * FROM master_products WHERE id = ${id}::uuid LIMIT 1`;
  return rows[0] ? toMasterProduct(rows[0] as Row) : null;
}

export async function findMasterProductByName(
  name: string,
  brand: string | null,
): Promise<MasterProduct | null> {
  const sql = getPlatformSql();
  if (!sql) return null;
  const normalizedName = normalizeSearchText(name);
  const normalizedBrand = normalizeSearchText(brand ?? '');
  const rows = await sql`
    SELECT * FROM master_products
     WHERE archived_at IS NULL
       AND normalized_name = ${normalizedName}
       AND normalize_search_text(COALESCE(brand, '')) = ${normalizedBrand}
     LIMIT 1
  `;
  return rows[0] ? toMasterProduct(rows[0] as Row) : null;
}

export async function createMasterProduct(input: MasterProductInput): Promise<MasterProduct> {
  const sql = requirePlatformSql();
  const name = clean(input.name, 160);
  if (!name) throw new CatalogError('invalid_master_product', 'El nombre es obligatorio.');

  const brand = clean(input.brand, 80);
  const existing = await findMasterProductByName(name, brand);
  if (existing) {
    throw new CatalogError(
      'master_product_exists',
      `Ya existe «${existing.name}»${existing.brand ? ` de ${existing.brand}` : ''} en el catálogo maestro.`,
      409,
    );
  }

  const slug = slugify(input.slug || name) || `producto-${Date.now()}`;
  const category = clean(input.category, 80);
  const description = clean(input.description, 4000);
  const imageUrl = clean(input.imageUrl, 500);
  const attributes =
    input.attributes && typeof input.attributes === 'object' ? input.attributes : {};

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
    try {
      const rows = await sql`
        INSERT INTO master_products (
          slug, name, brand, category, description, image_url, attributes, active
        ) VALUES (
          ${candidate}, ${name}, ${brand}, ${category}, ${description}, ${imageUrl},
          ${JSON.stringify(attributes)}::jsonb, ${input.active !== false}
        )
        RETURNING *
      `;
      return toMasterProduct(rows[0] as Row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const text = String((error as Error).message ?? '');
      if (text.includes('uq_master_products_identity')) {
        throw new CatalogError(
          'master_product_exists',
          'Ya existe un producto maestro con ese nombre y marca.',
          409,
        );
      }
      // Colisión de slug: probar sufijo.
    }
  }

  throw new CatalogError('master_product_slug_taken', 'No se pudo asignar un slug único.', 409);
}

export async function updateMasterProduct(
  id: string,
  patch: Partial<MasterProductInput> & { archived?: boolean },
): Promise<MasterProduct> {
  const sql = requirePlatformSql();
  const current = await getMasterProduct(id);
  if (!current) throw new CatalogError('master_product_not_found', 'Producto maestro no encontrado.', 404);

  if (patch.archived === true) {
    const rows = await sql`
      UPDATE master_products
         SET archived_at = COALESCE(archived_at, NOW()), active = FALSE, updated_at = NOW()
       WHERE id = ${id}::uuid
       RETURNING *
    `;
    return toMasterProduct(rows[0] as Row);
  }

  const name = patch.name === undefined ? current.name : clean(patch.name, 160);
  if (!name) throw new CatalogError('invalid_master_product', 'El nombre no puede quedar vacío.');

  const brand = patch.brand === undefined ? current.brand : clean(patch.brand, 80);
  const category = patch.category === undefined ? current.category : clean(patch.category, 80);
  const description =
    patch.description === undefined ? current.description : clean(patch.description, 4000);
  const imageUrl = patch.imageUrl === undefined ? current.imageUrl : clean(patch.imageUrl, 500);
  const attributes =
    patch.attributes === undefined ? current.attributes : patch.attributes;

  try {
    const rows = await sql`
      UPDATE master_products
         SET name = ${name},
             brand = ${brand},
             category = ${category},
             description = ${description},
             image_url = ${imageUrl},
             attributes = ${JSON.stringify(attributes)}::jsonb,
             active = ${patch.active === undefined ? current.active : patch.active === true},
             archived_at = CASE WHEN ${patch.active === true} THEN NULL ELSE archived_at END,
             updated_at = NOW()
       WHERE id = ${id}::uuid
       RETURNING *
    `;
    return toMasterProduct(rows[0] as Row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogError(
        'master_product_exists',
        'Ya existe otro producto maestro con ese nombre y marca.',
        409,
      );
    }
    throw error;
  }
}

export async function listMasterFacets(): Promise<{
  categories: string[];
  brands: string[];
  attributes: ProductOptionSchema[];
}> {
  const sql = getPlatformSql();
  if (!sql) return { categories: [], brands: [], attributes: [] };

  const rows = await sql`
    SELECT category, brand FROM master_products WHERE archived_at IS NULL
  `;
  const categories = new Set<string>();
  const brands = new Set<string>();
  for (const row of rows as Row[]) {
    const category = clean(row.category, 80);
    const brand = clean(row.brand, 80);
    if (category) categories.add(category);
    if (brand) brands.add(brand);
  }
  return {
    categories: [...categories].sort((a, b) => a.localeCompare(b, 'es')),
    brands: [...brands].sort((a, b) => a.localeCompare(b, 'es')),
    attributes: [],
  };
}

/** Conteo eficiente de SKU publicados por tienda (base para límites de plan). */
export async function countPublishedSkusByStore(storeId: string): Promise<number> {
  const sql = getPlatformSql();
  if (!sql) return 0;
  const rows = await sql`
    SELECT COUNT(*)::int AS total
      FROM store_products sp
     WHERE sp.store_id = ${storeId}::uuid
       AND sp.visible = TRUE
       AND sp.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM product_variants v
          WHERE v.store_product_id = sp.id AND v.archived_at IS NULL AND v.is_active
       )
    UNION ALL
    SELECT COUNT(*)::int AS total
      FROM product_variants v
      JOIN store_products sp ON sp.id = v.store_product_id
     WHERE v.store_id = ${storeId}::uuid
       AND sp.visible = TRUE
       AND sp.archived_at IS NULL
       AND v.archived_at IS NULL
       AND v.is_active
  `;
  return (rows as Row[]).reduce((sum, row) => sum + Number(row.total ?? 0), 0);
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === '23505';
}
