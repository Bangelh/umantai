/**
 * lib/stores.server.ts — acceso a datos de la plataforma multi-tienda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA DE AISLAMIENTO (P0)
 *
 *  Toda función que lee o escribe datos privados de una tienda recibe
 *  `storeId` + `userId`, y llama a `requireStoreAccess()` ANTES de consultar.
 *  No hay ninguna consulta "sin filtro de tienda" en el panel de comerciante.
 *  El filtro vive en el SQL, no en el componente.
 *
 *  Las funciones públicas (buscador, vitrina) solo devuelven tiendas activas y
 *  productos visibles; nunca contacto interno ni pedidos.
 *
 *  Sin N+1: la disponibilidad se agrega con LATERAL en la misma consulta; los
 *  listados usan una sola query. El buscador hace 2 consultas (productos y
 *  tiendas) sin importar cuántos resultados haya.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { boundingBox, type GeoPoint } from './geo';
import {
  normalizeSearchText,
  parseOptionSchema,
  type CatalogVariant,
  type ProductOptionSchema,
} from './catalog';
import type { DiscoveryProduct, DiscoveryQuery, DiscoveryStore } from './discovery';
import { normalizeQuery } from './discovery';
import { centsToUnits } from './format';
import {
  getPlatformSql,
  requirePlatformSql,
  toIsoString,
  toNullableNumber,
  toNumber,
} from './platform-db.server';
import {
  TenancyError,
  canOperateStore,
  normalizeStoreSlug,
  roleAtLeast,
  validateStoreSlug,
  type StoreRole,
} from './tenancy';
import {
  assertCanCreateStoreProduct,
  assertCanPublishStoreProduct,
  refreshStoreOverLimit,
} from './billing/sku.server';

/** Tienda interna de la fase 1. UUID fijo: también es el DEFAULT de las tablas. */
export const DEFAULT_STORE_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_STORE_SLUG = 'umantai';

// =============================================================================
//  TIPOS
// =============================================================================

export interface Store {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  imageUrl: string | null;
  category: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  contactEmail: string | null;
  contactPhone: string | null;
  active: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoreWithRole extends Store {
  role: StoreRole;
  productCount: number;
  orderCount: number;
}

export interface StoreProduct {
  id: string;
  storeId: string;
  masterProductId: string | null;
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  priceCents: number;
  currency: string;
  unit: string;
  visible: boolean;
  available: number;
  inStock: boolean;
  /** Ejes declarados (talla/color/peso…). Vacío = producto sin variantes. */
  optionSchema: ProductOptionSchema[];
  /** Variantes vendibles activas, con su stock real. */
  variants: CatalogVariant[];
  archivedAt: string | null;
}

export interface Storefront {
  store: Store;
  products: StoreProduct[];
}

export interface StoreOrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  total: number;
  currency: string;
  itemCount: number;
  contactEmail: string;
  fulfillmentType: string;
  createdAt: string;
  items: Array<{ name: string; quantity: number; lineTotal: number }>;
  /** Solo en el historial del cliente (link público /pedido/<token>). */
  publicToken?: string;
  /** Solo en el historial del cliente. */
  storeSlug?: string;
  storeName?: string;
}

// =============================================================================
//  MAPEADORES
// =============================================================================

type Row = Record<string, unknown>;

export function toStore(row: Row): Store {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: (row.description as string | null) ?? null,
    logoUrl: (row.logo_url as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    latitude: toNullableNumber(row.latitude),
    longitude: toNullableNumber(row.longitude),
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    active: row.active === true,
    isDefault: row.is_default === true,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toCatalogVariant(raw: unknown): CatalogVariant | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const available = toNumber(row.available);
  return {
    id: String(row.id),
    sku: String(row.sku),
    variantKey: String(row.variantKey ?? row.variant_key ?? ''),
    optionValues:
      row.optionValues && typeof row.optionValues === 'object'
        ? (row.optionValues as Record<string, string>)
        : row.option_values && typeof row.option_values === 'object'
          ? (row.option_values as Record<string, string>)
          : {},
    priceCents:
      row.priceCents === null || row.priceCents === undefined
        ? row.price_cents === null || row.price_cents === undefined
          ? null
          : toNumber(row.price_cents)
        : toNumber(row.priceCents),
    available,
    inStock: available > 0,
    active: row.active === undefined ? row.is_active !== false : row.active !== false,
  };
}

function parseVariantsField(value: unknown): CatalogVariant[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map(toCatalogVariant)
    .filter((variant): variant is CatalogVariant => variant !== null);
}

function toStoreProduct(row: Row): StoreProduct {
  const available = toNumber(row.available);
  return {
    id: String(row.id),
    storeId: String(row.store_id),
    masterProductId: (row.master_product_id as string | null) ?? null,
    slug: String(row.slug),
    name: String(row.name),
    brand: (row.brand as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    priceCents: toNumber(row.price_cents),
    currency: String(row.currency ?? 'PEN'),
    unit: String(row.unit ?? 'unidad'),
    visible: row.visible === true,
    available,
    inStock: available > 0,
    optionSchema: parseOptionSchema(row.option_schema),
    variants: parseVariantsField(row.variants),
    archivedAt: row.archived_at ? toIsoString(row.archived_at) : null,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// =============================================================================
//  LECTURA PÚBLICA
// =============================================================================

export async function getStoreBySlug(slug: string): Promise<Store | null> {
  const sql = getPlatformSql();
  if (!sql) return null;

  const rows = await sql`
    SELECT * FROM stores
     WHERE lower(slug) = lower(${normalizeStoreSlug(slug)})
       AND active = TRUE
     LIMIT 1
  `;
  return rows[0] ? toStore(rows[0] as Row) : null;
}

/**
 * Buscador global. Dos consultas, sin N+1:
 *   1. productos (con total por window function, para paginar)
 *   2. tiendas cercanas (con conteo de productos y de disponibles)
 */
export async function searchDiscovery(
  query: DiscoveryQuery,
): Promise<{ products: DiscoveryProduct[]; stores: DiscoveryStore[]; total: number }> {
  const sql = getPlatformSql();
  if (!sql) return { products: [], stores: [], total: 0 };

  const q = normalizeQuery(query.q);
  const nq = normalizeSearchText(q);
  const likes = q ? `%${escapeLike(nq)}%` : '%';
  const prefix = q ? `${escapeLike(nq)}%` : '%';
  const hasGeo = query.location !== null;
  const location: GeoPoint = query.location ?? { latitude: 0, longitude: 0 };
  const bounds = hasGeo ? boundingBox(location, query.radiusKm) : null;

  const [productRows, storeRows] = await sql.transaction(
    [
      sql`
        WITH matched AS (
          SELECT
            sp.store_id::text        AS store_id,
            s.slug                   AS store_slug,
            s.name                   AS store_name,
            s.category               AS store_category,
            sp.slug                  AS product_slug,
            sp.name                  AS name,
            sp.brand                 AS brand,
            sp.category              AS category,
            sp.description           AS description,
            CASE WHEN COALESCE(variants.variant_count, 0) > 0
              THEN variants.min_price ELSE sp.price_cents END AS price_cents,
            sp.currency              AS currency,
            sp.unit                  AS unit,
            COALESCE(inv.available, 0)::int AS available,
            COALESCE(variants.variant_count, 0)::int AS variant_count,
            CASE WHEN ${hasGeo}::boolean
              THEN geo_distance_km(
                ${location.latitude}::float8, ${location.longitude}::float8,
                s.latitude, s.longitude
              )
              ELSE NULL
            END AS distance_km,
            CASE
              WHEN ${nq} = '' THEN 5
              WHEN sp.normalized_name = ${nq} THEN 0
              WHEN sp.normalized_name LIKE ${prefix} ESCAPE '\\' THEN 1
              WHEN sp.normalized_name LIKE ${likes} ESCAPE '\\' THEN 2
              WHEN normalize_search_text(COALESCE(sp.brand, '')) LIKE ${likes} ESCAPE '\\'
                OR normalize_search_text(COALESCE(sp.category, '')) LIKE ${likes} ESCAPE '\\' THEN 3
              WHEN normalize_search_text(COALESCE(mp.name, '')) LIKE ${likes} ESCAPE '\\'
                OR normalize_search_text(COALESCE(mp.brand, '')) LIKE ${likes} ESCAPE '\\' THEN 4
              ELSE 5
            END AS relevance
          FROM store_products sp
          JOIN stores s ON s.id = sp.store_id AND s.active = TRUE
          LEFT JOIN master_products mp ON mp.id = sp.master_product_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(i.quantity_available), 0)::int AS available
              FROM inventory i
             WHERE i.store_id = sp.store_id
               AND i.product_slug = sp.slug
               AND i.is_active = TRUE
               AND (
                 EXISTS (
                   SELECT 1 FROM product_variants vx
                    WHERE vx.store_product_id = sp.id
                      AND vx.archived_at IS NULL AND vx.is_active
                      AND vx.variant_key = i.variant_key
                 )
                 OR (
                   NOT EXISTS (
                     SELECT 1 FROM product_variants vx
                      WHERE vx.store_product_id = sp.id
                        AND vx.archived_at IS NULL AND vx.is_active
                   )
                   AND i.variant_key = ''
                 )
               )
          ) inv ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS variant_count,
                   MIN(COALESCE(v.price_cents, sp.price_cents)) AS min_price
              FROM product_variants v
             WHERE v.store_product_id = sp.id
               AND v.archived_at IS NULL AND v.is_active
          ) variants ON TRUE
          WHERE sp.visible = TRUE
            AND sp.archived_at IS NULL
            AND (
              ${nq} = ''
              OR sp.normalized_name LIKE ${likes} ESCAPE '\\'
              OR normalize_search_text(COALESCE(sp.brand, '')) LIKE ${likes} ESCAPE '\\'
              OR normalize_search_text(COALESCE(sp.category, '')) LIKE ${likes} ESCAPE '\\'
              OR normalize_search_text(COALESCE(mp.name, '')) LIKE ${likes} ESCAPE '\\'
              OR normalize_search_text(COALESCE(mp.brand, '')) LIKE ${likes} ESCAPE '\\'
            )
            AND (
              NOT ${hasGeo}::boolean
              OR (
                s.latitude BETWEEN ${bounds?.minLat ?? -90}::float8 AND ${bounds?.maxLat ?? 90}::float8
                AND s.longitude BETWEEN ${bounds?.minLng ?? -180}::float8 AND ${bounds?.maxLng ?? 180}::float8
              )
            )
        )
        SELECT *, COUNT(*) OVER()::int AS total
          FROM matched
         WHERE (NOT ${hasGeo}::boolean OR distance_km <= ${query.radiusKm}::float8)
         ORDER BY relevance ASC,
                  distance_km ASC NULLS LAST,
                  available DESC,
                  name ASC,
                  store_slug ASC
         LIMIT ${query.limit} OFFSET ${query.offset}
      `,
      sql`
        SELECT * FROM (
          SELECT
            s.id,
            s.slug,
            s.name,
            s.category,
            s.description,
            s.address,
            s.district,
            s.city,
            s.logo_url,
            CASE WHEN ${hasGeo}::boolean
              THEN geo_distance_km(
                ${location.latitude}::float8, ${location.longitude}::float8,
                s.latitude, s.longitude
              )
              ELSE NULL
            END AS distance_km,
            COUNT(sp.id)::int AS product_count,
            COUNT(sp.id) FILTER (WHERE COALESCE(inv.available, 0) > 0)::int AS in_stock_count
          FROM stores s
          LEFT JOIN store_products sp
            ON sp.store_id = s.id AND sp.visible = TRUE AND sp.archived_at IS NULL
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(i.quantity_available), 0)::int AS available
              FROM inventory i
             WHERE i.store_id = sp.store_id
               AND i.product_slug = sp.slug
               AND i.is_active = TRUE
               AND (
                 EXISTS (
                   SELECT 1 FROM product_variants vx
                    WHERE vx.store_product_id = sp.id
                      AND vx.archived_at IS NULL AND vx.is_active
                      AND vx.variant_key = i.variant_key
                 )
                 OR (
                   NOT EXISTS (
                     SELECT 1 FROM product_variants vx
                      WHERE vx.store_product_id = sp.id
                        AND vx.archived_at IS NULL AND vx.is_active
                   )
                   AND i.variant_key = ''
                 )
               )
          ) inv ON TRUE
          WHERE s.active = TRUE
            AND (
              ${nq} = ''
              OR normalize_search_text(s.name) LIKE ${likes} ESCAPE '\\'
              OR normalize_search_text(COALESCE(s.category, '')) LIKE ${likes} ESCAPE '\\'
              OR EXISTS (
                SELECT 1
                  FROM store_products sp2
                  LEFT JOIN master_products mp2 ON mp2.id = sp2.master_product_id
                 WHERE sp2.store_id = s.id
                   AND sp2.visible = TRUE
                   AND sp2.archived_at IS NULL
                   AND (
                     sp2.normalized_name LIKE ${likes} ESCAPE '\\'
                     OR normalize_search_text(COALESCE(sp2.brand, '')) LIKE ${likes} ESCAPE '\\'
                     OR normalize_search_text(COALESCE(sp2.category, '')) LIKE ${likes} ESCAPE '\\'
                     OR normalize_search_text(COALESCE(mp2.name, '')) LIKE ${likes} ESCAPE '\\'
                     OR normalize_search_text(COALESCE(mp2.brand, '')) LIKE ${likes} ESCAPE '\\'
                   )
              )
            )
            AND (
              NOT ${hasGeo}::boolean
              OR (
                s.latitude BETWEEN ${bounds?.minLat ?? -90}::float8 AND ${bounds?.maxLat ?? 90}::float8
                AND s.longitude BETWEEN ${bounds?.minLng ?? -180}::float8 AND ${bounds?.maxLng ?? 180}::float8
              )
            )
          GROUP BY s.id
        ) nearby
        WHERE (NOT ${hasGeo}::boolean OR distance_km <= ${query.radiusKm}::float8)
        ORDER BY distance_km ASC NULLS LAST,
                 product_count DESC,
                 in_stock_count DESC,
                 name ASC
        LIMIT 12
      `,
    ],
    { readOnly: true },
  );

  const products: DiscoveryProduct[] = (productRows as Row[]).map((row) => ({
    storeId: String(row.store_id),
    storeSlug: String(row.store_slug),
    storeName: String(row.store_name),
    storeCategory: (row.store_category as string | null) ?? null,
    productSlug: String(row.product_slug),
    name: String(row.name),
    brand: (row.brand as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    priceCents: toNumber(row.price_cents),
    currency: String(row.currency ?? 'PEN'),
    unit: String(row.unit ?? 'unidad'),
    available: toNumber(row.available),
    inStock: toNumber(row.available) > 0,
    distanceKm: toNullableNumber(row.distance_km),
    variantCount: toNumber(row.variant_count),
    hasVariants: toNumber(row.variant_count) > 0,
  }));

  const stores: DiscoveryStore[] = (storeRows as Row[]).map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    category: (row.category as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    logoUrl: (row.logo_url as string | null) ?? null,
    distanceKm: toNullableNumber(row.distance_km),
    productCount: toNumber(row.product_count),
    inStockCount: toNumber(row.in_stock_count),
  }));

  return {
    products,
    stores,
    total: productRows[0] ? toNumber((productRows[0] as Row).total) : 0,
  };
}

/** Vitrina de una tienda: datos públicos + catálogo visible. */
export async function getStorefront(slug: string): Promise<Storefront | null> {
  const sql = getPlatformSql();
  if (!sql) return null;

  const store = await getStoreBySlug(slug);
  if (!store) return null;

  const rows = await sql`
    SELECT sp.*, COALESCE(inv.available, 0)::int AS available,
           COALESCE(vv.variants, '[]'::json) AS variants
      FROM store_products sp
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.quantity_available), 0)::int AS available
          FROM inventory i
         WHERE i.store_id = sp.store_id
           AND i.product_slug = sp.slug
           AND i.is_active = TRUE
           AND (
             EXISTS (
               SELECT 1 FROM product_variants vx
                WHERE vx.store_product_id = sp.id
                  AND vx.archived_at IS NULL AND vx.is_active
                  AND vx.variant_key = i.variant_key
             )
             OR (
               NOT EXISTS (
                 SELECT 1 FROM product_variants vx
                  WHERE vx.store_product_id = sp.id
                    AND vx.archived_at IS NULL AND vx.is_active
               )
               AND i.variant_key = ''
             )
           )
      ) inv ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', v.id, 'sku', v.sku, 'variantKey', v.variant_key,
                 'optionValues', v.option_values, 'priceCents', v.price_cents,
                 'active', v.is_active,
                 'available', COALESCE((
                   SELECT SUM(i2.quantity_available)::int
                     FROM inventory i2
                    WHERE i2.store_id = v.store_id
                      AND i2.product_slug = sp.slug
                      AND i2.variant_key = v.variant_key
                      AND i2.is_active
                 ), 0)
               ) ORDER BY v.variant_key) AS variants
          FROM product_variants v
         WHERE v.store_product_id = sp.id
           AND v.archived_at IS NULL
           AND v.is_active
      ) vv ON TRUE
     WHERE sp.store_id = ${store.id}::uuid
       AND sp.visible = TRUE
       AND sp.archived_at IS NULL
     ORDER BY lower(COALESCE(sp.category, '')), lower(sp.name)
     LIMIT 500
  `;

  return { store, products: (rows as Row[]).map(toStoreProduct) };
}

/** Detalle público de un producto de tienda (para /<store>/p/<slug>). */
export async function getStoreProductDetail(
  storeSlug: string,
  productSlug: string,
): Promise<{ store: Store; product: StoreProduct } | null> {
  const sql = getPlatformSql();
  if (!sql) return null;

  const store = await getStoreBySlug(storeSlug);
  if (!store) return null;

  // Dos consultas (tienda + producto), sin joins ambiguos de columnas
  // homónimas (`name`/`slug`/`category` existen en ambas tablas).
  const rows = await sql`
    SELECT sp.*, COALESCE(inv.available, 0)::int AS available,
           COALESCE(vv.variants, '[]'::json) AS variants
      FROM store_products sp
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.quantity_available), 0)::int AS available
          FROM inventory i
         WHERE i.store_id = sp.store_id
           AND i.product_slug = sp.slug
           AND i.is_active = TRUE
           AND (
             EXISTS (
               SELECT 1 FROM product_variants vx
                WHERE vx.store_product_id = sp.id
                  AND vx.archived_at IS NULL AND vx.is_active
                  AND vx.variant_key = i.variant_key
             )
             OR (
               NOT EXISTS (
                 SELECT 1 FROM product_variants vx
                  WHERE vx.store_product_id = sp.id
                    AND vx.archived_at IS NULL AND vx.is_active
               )
               AND i.variant_key = ''
             )
           )
      ) inv ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', v.id, 'sku', v.sku, 'variantKey', v.variant_key,
                 'optionValues', v.option_values, 'priceCents', v.price_cents,
                 'active', v.is_active,
                 'available', COALESCE((
                   SELECT SUM(i2.quantity_available)::int
                     FROM inventory i2
                    WHERE i2.store_id = v.store_id
                      AND i2.product_slug = sp.slug
                      AND i2.variant_key = v.variant_key
                      AND i2.is_active
                 ), 0)
               ) ORDER BY v.variant_key) AS variants
          FROM product_variants v
         WHERE v.store_product_id = sp.id
           AND v.archived_at IS NULL
           AND v.is_active
      ) vv ON TRUE
     WHERE sp.store_id = ${store.id}::uuid
       AND sp.slug = ${productSlug}
       AND sp.visible = TRUE
       AND sp.archived_at IS NULL
     LIMIT 1
  `;

  const row = rows[0] as Row | undefined;
  if (!row) return null;

  return { store, product: toStoreProduct(row) };
}

// =============================================================================
//  IDENTIDAD + TIENDAS DEL MERCHANT
// =============================================================================

export async function listStoresForUser(userId: string): Promise<StoreWithRole[]> {
  const sql = getPlatformSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT s.*, sm.role,
           (SELECT COUNT(*)::int FROM store_products sp WHERE sp.store_id = s.id) AS product_count,
           (SELECT COUNT(*)::int FROM orders o WHERE o.store_id = s.id) AS order_count
      FROM store_members sm
      JOIN stores s ON s.id = sm.store_id
     WHERE sm.user_id = ${userId}
     ORDER BY lower(s.name)
  `;

  return (rows as Row[]).map((row) => ({
    ...toStore(row),
    role: row.role as StoreRole,
    productCount: toNumber(row.product_count),
    orderCount: toNumber(row.order_count),
  }));
}

/**
 * Portero de aislamiento. Devuelve la tienda y el rol SOLO si el usuario es
 * miembro con el rol mínimo; si no, lanza. Ninguna función store-scoped debe
 * saltarse esta llamada.
 */
export async function requireStoreAccess(
  userId: string,
  storeId: string,
  minimumRole: StoreRole = 'admin',
): Promise<{ store: Store; role: StoreRole }> {
  if (!userId) {
    throw new TenancyError('not_authenticated', 'Necesitas iniciar sesión.');
  }

  const sql = requirePlatformSql();
  const rows = await sql`
    SELECT s.*, sm.role
      FROM stores s
      LEFT JOIN store_members sm
        ON sm.store_id = s.id AND sm.user_id = ${userId}
     WHERE s.id = ${storeId}::uuid
     LIMIT 1
  `;

  const row = rows[0] as Row | undefined;
  if (!row) {
    throw new TenancyError('store_not_found', 'Tienda no encontrada.');
  }

  const role = (row.role as StoreRole | null) ?? null;
  if (!canOperateStore(role) || !roleAtLeast(role, minimumRole)) {
    // Mismo 403 exista o no el recurso: no se filtra información entre tiendas.
    throw new TenancyError('store_forbidden', 'No tienes acceso a esta tienda.');
  }

  return { store: toStore(row), role: role as StoreRole };
}

export interface CreateStoreInput {
  ownerUserId: string;
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === '23505';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Alta controlada de comercio:
 *   · crea la tienda INACTIVA (nadie la ve hasta que el equipo la apruebe),
 *   · asocia al creador como `owner`,
 *   · valida el slug en la app y en la DB.
 *
 * La tienda nace en Free por trigger de DB (migración 017); no requiere método
 * de pago. El alta no cobra nada.
 */
export async function createStoreForOwner(input: CreateStoreInput): Promise<Store> {
  const sql = requirePlatformSql();

  const name = (input.name ?? '').trim();
  if (name.length < 2 || name.length > 80) {
    throw new TenancyError('invalid_store_input', 'El nombre del negocio debe tener entre 2 y 80 caracteres.');
  }

  const slugCheck = validateStoreSlug(input.slug || name);
  if (!slugCheck.ok) {
    throw new TenancyError('invalid_store_input', slugCheck.message);
  }

  const latitude = input.latitude ?? null;
  const longitude = input.longitude ?? null;
  if ((latitude === null) !== (longitude === null)) {
    throw new TenancyError('invalid_store_input', 'Debes indicar latitud y longitud juntas.');
  }
  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    throw new TenancyError('invalid_store_input', 'Latitud fuera de rango.');
  }
  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    throw new TenancyError('invalid_store_input', 'Longitud fuera de rango.');
  }

  const candidates = [slugCheck.slug];
  for (let i = 2; i <= 5; i += 1) candidates.push(`${slugCheck.slug}-${i}`);

  for (const candidate of candidates) {
    try {
      const results = await sql.transaction([
        sql`
          INSERT INTO stores (
            name, slug, description, category,
            address, district, city, latitude, longitude,
            contact_email, contact_phone, active, metadata
          ) VALUES (
            ${name}, ${candidate}, ${input.description ?? null}, ${input.category ?? null},
            ${input.address ?? null}, ${input.district ?? null}, ${input.city ?? null},
            ${latitude}::float8, ${longitude}::float8,
            ${input.contactEmail ?? null}, ${input.contactPhone ?? null},
            FALSE, ${JSON.stringify({ source: 'merchant_onboarding' })}::jsonb
          )
          RETURNING *
        `,
        sql`
          INSERT INTO store_members (store_id, user_id, role)
          SELECT id, ${input.ownerUserId}, 'owner'
            FROM stores
           WHERE slug = ${candidate}
          RETURNING store_id
        `,
      ]);

      const row = (results[0]?.[0] ?? null) as Row | null;
      if (!row) throw new Error('store_insert_failed');
      return toStore(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const text = errorText(error);
      if (text.includes('reserved_store_slug')) {
        throw new TenancyError('invalid_store_input', 'Ese identificador está reservado por UMANTAI.');
      }
      // Colisión de slug: se prueba el siguiente sufijo.
    }
  }

  throw new TenancyError('store_slug_taken', 'Ese identificador ya está en uso. Prueba con otro.');
}

// =============================================================================
//  PANEL DEL COMERCIANTE (store-scoped, SIEMPRE con requireStoreAccess)
// =============================================================================

export async function listStoreProducts(
  userId: string,
  storeId: string,
): Promise<StoreProduct[]> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  const rows = await sql`
    SELECT sp.*, COALESCE(inv.available, 0)::int AS available,
           COALESCE(vv.variants, '[]'::json) AS variants
      FROM store_products sp
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.quantity_available), 0)::int AS available
          FROM inventory i
         WHERE i.store_id = sp.store_id
           AND i.product_slug = sp.slug
           AND i.is_active = TRUE
           AND (
             EXISTS (
               SELECT 1 FROM product_variants vx
                WHERE vx.store_product_id = sp.id
                  AND vx.archived_at IS NULL AND vx.is_active
                  AND vx.variant_key = i.variant_key
             )
             OR (
               NOT EXISTS (
                 SELECT 1 FROM product_variants vx
                  WHERE vx.store_product_id = sp.id
                    AND vx.archived_at IS NULL AND vx.is_active
               )
               AND i.variant_key = ''
             )
           )
      ) inv ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', v.id, 'sku', v.sku, 'variantKey', v.variant_key,
                 'optionValues', v.option_values, 'priceCents', v.price_cents,
                 'active', v.is_active,
                 'available', COALESCE((
                   SELECT SUM(i2.quantity_available)::int
                     FROM inventory i2
                    WHERE i2.store_id = v.store_id
                      AND i2.product_slug = sp.slug
                      AND i2.variant_key = v.variant_key
                      AND i2.is_active
                 ), 0)
               ) ORDER BY v.variant_key) AS variants
          FROM product_variants v
         WHERE v.store_product_id = sp.id
           AND v.archived_at IS NULL
           AND v.is_active
      ) vv ON TRUE
     WHERE sp.store_id = ${storeId}::uuid
       AND sp.archived_at IS NULL
     ORDER BY lower(sp.name)
     LIMIT 500
  `;
  return (rows as Row[]).map(toStoreProduct);
}

export interface CreateStoreProductInput {
  slug?: string;
  name: string;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  priceCents: number;
  unit?: string;
  masterProductId?: string | null;
  visible?: boolean;
  /** Stock inicial (opcional). Se aplica como `receipt` en el ledger. */
  initialStock?: number;
}

export async function createStoreProduct(
  userId: string,
  storeId: string,
  input: CreateStoreProductInput,
): Promise<StoreProduct> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  const name = (input.name ?? '').trim();
  if (name.length < 1 || name.length > 160) {
    throw new TenancyError('invalid_store_input', 'El nombre del producto debe tener entre 1 y 160 caracteres.');
  }

  const priceCents = Math.round(Number(input.priceCents));
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    throw new TenancyError('invalid_store_input', 'El precio debe ser un entero de centavos >= 0.');
  }

  const slug = normalizeStoreSlug(input.slug || name) || 'producto';
  const initialStock = Math.max(0, Math.floor(Number(input.initialStock ?? 0)));

  await assertCanCreateStoreProduct(storeId, { visible: input.visible ?? true, activeVariants: 0 });

  try {
    const rows = await sql`
      INSERT INTO store_products (
        store_id, master_product_id, slug, name, brand, category, description,
        image_url, price_cents, unit, visible
      ) VALUES (
        ${storeId}::uuid, ${input.masterProductId ?? null}::uuid, ${slug}, ${name},
        ${input.brand ?? null}, ${input.category ?? null}, ${input.description ?? null},
        ${input.imageUrl ?? null}, ${priceCents}, ${input.unit ?? 'unidad'},
        ${input.visible ?? true}
      )
      RETURNING *
    `;

    const row = rows[0] as Row | undefined;
    if (!row) throw new Error('store_product_insert_failed');

    if (initialStock > 0) {
      await sql`
        SELECT inventory_apply_movement(
          ${slug}, '', 'receipt'::inventory_movement_type,
          ${initialStock}, 0, 'MAIN', NULL, NULL,
          'initial_stock', ${`merchant:${userId}`}, ${`initial:${storeId}:${slug}`},
          ${storeId}::uuid
        )
      `;
    }

    await refreshStoreOverLimit(storeId);
    const available = initialStock;
    return toStoreProduct({ ...row, available });
  } catch (error) {
    if (isUniqueViolation(error) && errorText(error).includes('store_products_store_slug_unique')) {
      throw new TenancyError('store_product_slug_taken', 'Ya existe un producto con ese identificador en tu tienda.');
    }
    throw error;
  }
}

export interface UpdateStoreProductInput {
  name?: string | null;
  description?: string | null;
  category?: string | null;
  brand?: string | null;
  priceCents?: number | null;
  visible?: boolean | null;
}

export async function updateStoreProduct(
  userId: string,
  storeId: string,
  productId: string,
  patch: UpdateStoreProductInput,
): Promise<StoreProduct> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  if (patch.priceCents !== undefined && patch.priceCents !== null) {
    if (!Number.isInteger(patch.priceCents) || patch.priceCents < 0) {
      throw new TenancyError('invalid_store_input', 'El precio debe ser un entero de centavos >= 0.');
    }
  }

  if (patch.visible === true) {
    await assertCanPublishStoreProduct(storeId, productId);
  }

  const rows = await sql`
    UPDATE store_products
       SET name        = COALESCE(${patch.name ?? null}, name),
           description = COALESCE(${patch.description ?? null}, description),
           category    = COALESCE(${patch.category ?? null}, category),
           brand       = COALESCE(${patch.brand ?? null}, brand),
           price_cents = COALESCE(${patch.priceCents ?? null}, price_cents),
           visible     = COALESCE(${patch.visible ?? null}, visible)
     WHERE id = ${productId}::uuid
       AND store_id = ${storeId}::uuid
     RETURNING *
  `;

  const row = rows[0] as Row | undefined;
  if (!row) {
    throw new TenancyError('store_product_not_found', 'Producto no encontrado en esta tienda.');
  }
  await refreshStoreOverLimit(storeId);
  return toStoreProduct({ ...row, available: 0 });
}

export async function listStoreOrders(
  userId: string,
  storeId: string,
  limit = 50,
): Promise<StoreOrderSummary[]> {
  await requireStoreAccess(userId, storeId);
  const sql = requirePlatformSql();

  const rows = await sql`
    SELECT o.id, o.order_number, o.status, o.payment_status, o.total, o.currency,
           o.item_count, o.contact_email, o.fulfillment_type, o.created_at,
           COALESCE(
             json_agg(
               json_build_object(
                 'name', oi.product_name,
                 'quantity', oi.quantity,
                 'lineTotal', oi.line_total
               )
               ORDER BY oi.line_number
             ) FILTER (WHERE oi.id IS NOT NULL),
             '[]'::json
           ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.store_id = ${storeId}::uuid
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT ${Math.min(200, Math.max(1, limit))}
  `;

  return (rows as Row[]).map((row) => ({
    id: String(row.id),
    orderNumber: String(row.order_number),
    status: String(row.status),
    paymentStatus: String(row.payment_status),
    total: toNumber(row.total),
    currency: String(row.currency ?? 'PEN'),
    itemCount: toNumber(row.item_count),
    contactEmail: String(row.contact_email),
    fulfillmentType: String(row.fulfillment_type),
    createdAt: toIsoString(row.created_at),
    items: Array.isArray(row.items)
      ? (row.items as Array<Record<string, unknown>>).map((item) => ({
          name: String(item.name),
          quantity: toNumber(item.quantity),
          lineTotal: toNumber(item.lineTotal),
        }))
      : [],
  }));
}

// =============================================================================
//  CUENTA DE CLIENTE
// =============================================================================

export async function listCustomerOrders(userId: string, limit = 50): Promise<StoreOrderSummary[]> {
  const sql = getPlatformSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT o.id, o.order_number, o.public_token, o.status, o.payment_status, o.total, o.currency,
           o.item_count, o.contact_email, o.fulfillment_type, o.created_at,
           s.slug AS store_slug, s.name AS store_name,
           COALESCE(
             json_agg(
               json_build_object(
                 'name', oi.product_name,
                 'quantity', oi.quantity,
                 'lineTotal', oi.line_total
               )
               ORDER BY oi.line_number
             ) FILTER (WHERE oi.id IS NOT NULL),
             '[]'::json
           ) AS items
      FROM orders o
      JOIN stores s ON s.id = o.store_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = ${userId}
     GROUP BY o.id, s.slug, s.name
     ORDER BY o.created_at DESC
     LIMIT ${Math.min(200, Math.max(1, limit))}
  `;

  return (rows as Row[]).map((row) => ({
    id: String(row.id),
    orderNumber: String(row.order_number),
    publicToken: String(row.public_token),
    status: String(row.status),
    paymentStatus: String(row.payment_status),
    total: toNumber(row.total),
    currency: String(row.currency ?? 'PEN'),
    itemCount: toNumber(row.item_count),
    contactEmail: String(row.contact_email),
    fulfillmentType: String(row.fulfillment_type),
    createdAt: toIsoString(row.created_at),
    storeSlug: String(row.store_slug),
    storeName: String(row.store_name),
    items: Array.isArray(row.items)
      ? (row.items as Array<Record<string, unknown>>).map((item) => ({
          name: String(item.name),
          quantity: toNumber(item.quantity),
          lineTotal: toNumber(item.lineTotal),
        }))
      : [],
  }));
}

export interface CustomerProfile {
  name: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  docType: string | null;
  docNumber: string | null;
  defaultAddress: Record<string, unknown> | null;
}

export async function getCustomerProfile(userId: string): Promise<CustomerProfile | null> {
  const sql = getPlatformSql();
  if (!sql) return null;

  const rows = await sql`
    SELECT u.id, u.name, u.email,
           p.full_name, p.phone, p.doc_type, p.doc_number, p.default_address
      FROM users u
      LEFT JOIN customer_profiles p ON p.user_id = u.id
     WHERE u.id = ${userId}
     LIMIT 1
  `;

  const row = rows[0] as Row | undefined;
  if (!row) return null;

  return {
    name: String(row.name),
    email: String(row.email),
    fullName: (row.full_name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    docType: (row.doc_type as string | null) ?? null,
    docNumber: (row.doc_number as string | null) ?? null,
    defaultAddress: (row.default_address as Record<string, unknown> | null) ?? null,
  };
}

export async function updateCustomerProfile(
  userId: string,
  input: { fullName?: string | null; phone?: string | null; docType?: string | null; docNumber?: string | null },
): Promise<void> {
  const sql = requirePlatformSql();
  await sql`
    INSERT INTO customer_profiles (user_id, full_name, phone, doc_type, doc_number, updated_at)
    VALUES (${userId}, ${input.fullName ?? null}, ${input.phone ?? null},
            ${input.docType ?? null}, ${input.docNumber ?? null}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      full_name  = COALESCE(EXCLUDED.full_name, customer_profiles.full_name),
      phone      = COALESCE(EXCLUDED.phone, customer_profiles.phone),
      doc_type   = COALESCE(EXCLUDED.doc_type, customer_profiles.doc_type),
      doc_number = COALESCE(EXCLUDED.doc_number, customer_profiles.doc_number),
      updated_at = NOW()
  `;
}

// =============================================================================
//  CHECKOUT — resolución SERVER-SIDE de la tienda y los precios
// =============================================================================

export interface CheckoutProduct {
  productSlug: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  unitPrice: number;
  storeId: string;
  storeSlug: string;
}

/**
 * Resuelve los productos de una tienda para el checkout.
 *
 * El cliente manda slugs; el precio SIEMPRE sale de `store_products` (nunca del
 * navegador). Si algún slug no existe, no es visible o falta stock de fila, la
 * ruta responde 400 antes de tocar inventario.
 */
export async function resolveCheckoutProducts(
  storeSlug: string | null,
  productSlugs: string[],
): Promise<{ store: Store; products: Map<string, CheckoutProduct> } | null> {
  const sql = getPlatformSql();
  if (!sql) return null;

  const slug = storeSlug ? normalizeStoreSlug(storeSlug) : DEFAULT_STORE_SLUG;

  const storeRows = await sql`
    SELECT * FROM stores
     WHERE lower(slug) = lower(${slug})
       AND (active = TRUE OR is_default = TRUE)
     LIMIT 1
  `;
  const storeRow = storeRows[0] as Row | undefined;
  if (!storeRow) return null;
  const store = toStore(storeRow);

  const rows = await sql`
    SELECT sp.slug, sp.name, sp.brand, sp.image_url, sp.price_cents
      FROM store_products sp
     WHERE sp.store_id = ${store.id}::uuid
       AND sp.visible = TRUE
       AND sp.slug = ANY(${productSlugs}::text[])
  `;

  const products = new Map<string, CheckoutProduct>();
  for (const row of rows as Row[]) {
    products.set(String(row.slug), {
      productSlug: String(row.slug),
      name: String(row.name),
      brand: (row.brand as string | null) ?? null,
      imageUrl: (row.image_url as string | null) ?? null,
      unitPrice: centsToUnits(toNumber(row.price_cents)),
      storeId: store.id,
      storeSlug: store.slug,
    });
  }

  return { store, products };
}
