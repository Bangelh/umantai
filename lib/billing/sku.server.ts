/**
 * lib/billing/sku.server.ts — la ÚNICA regla de consumo de SKU.
 *
 * El conteo vive en la vista `store_sku_usage` (migración 017):
 *   · producto visible/no archivado sin variantes activas → 1
 *   · cada variante activa/no archivada de producto visible → 1
 *   · producto oculto/archivado, variante inactiva/archivada → 0
 *
 * Este módulo agrega el ENFORCEMENT antes de publicar/activar/crear. Nunca
 * despublica ni borra productos por su cuenta: si una tienda queda por encima
 * del límite, `over_limit_at` se marca y las nuevas publicaciones se bloquean.
 */

import { BillingError, PlanLimitError, type SubscriptionStatus } from '@/lib/billing';
import { requirePlatformSql } from '@/lib/platform-db.server';
import type { SqlClient } from '@/lib/db-driver.server';
import { toNumber } from '@/lib/platform-db.server';

export interface StorePlanInfo {
  storeId: string;
  planCode: string;
  planName: string;
  limit: number;
  status: SubscriptionStatus;
}

export interface StoreSkuSnapshot extends StorePlanInfo {
  current: number;
  overLimit: boolean;
}

/** Conteo canónico. La vista es la definición; no se replica el SQL. */
export async function countStoreSkus(storeId: string, sql: SqlClient = requirePlatformSql()): Promise<number> {
  const rows = await sql`
    SELECT COALESCE((SELECT sku_count FROM store_sku_usage WHERE store_id = ${storeId}::uuid), 0)::int AS sku_count
  `;
  return toNumber(rows[0]?.sku_count);
}

/**
 * Plan efectivo de la tienda. Si una tienda antigua no tuviera suscripción
 * (no debería pasar después de 017), cae a Free explícito, nunca a NULL.
 */
export async function getStorePlanInfo(storeId: string, sql: SqlClient = requirePlatformSql()): Promise<StorePlanInfo> {
  const rows = await sql`
    SELECT s.id AS store_id,
           COALESCE(p.code, fp.code) AS plan_code,
           COALESCE(p.name, fp.name) AS plan_name,
           COALESCE(p.sku_limit, fp.sku_limit)::int AS sku_limit,
           COALESCE(ss.status, 'free') AS status
      FROM stores s
      LEFT JOIN store_subscriptions ss ON ss.store_id = s.id
      LEFT JOIN plans p ON p.id = ss.plan_id
      LEFT JOIN LATERAL (
        SELECT code, name, sku_limit FROM plans WHERE lower(code) = 'free' LIMIT 1
      ) fp ON TRUE
     WHERE s.id = ${storeId}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new BillingError('store_not_found', 'Tienda no encontrada.', 404);
  return {
    storeId: String(row.store_id),
    planCode: String(row.plan_code),
    planName: String(row.plan_name),
    limit: toNumber(row.sku_limit),
    status: String(row.status) as SubscriptionStatus,
  };
}

export async function getStoreSkuSnapshot(
  storeId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<StoreSkuSnapshot> {
  const [plan, current] = await Promise.all([getStorePlanInfo(storeId, sql), countStoreSkus(storeId, sql)]);
  return { ...plan, current, overLimit: current > plan.limit };
}

/**
 * Chequeo central. `requested` es el DELTA de SKU que agrega la operación.
 * El límite exacto se permite; límite + 1 se rechaza.
 */
export async function assertCanAddStoreSkus(
  storeId: string,
  requested: number,
  sql: SqlClient = requirePlatformSql(),
): Promise<StoreSkuSnapshot> {
  const snapshot = await getStoreSkuSnapshot(storeId, sql);
  const delta = Math.max(0, Math.trunc(requested));
  if (snapshot.current + delta > snapshot.limit) {
    throw new PlanLimitError({
      plan: snapshot.planCode,
      limit: snapshot.limit,
      current: snapshot.current,
      requested: delta,
    });
  }
  return { ...snapshot, overLimit: snapshot.current + delta > snapshot.limit };
}

/** Antes de publicar un producto oculto (visible false → true). */
export async function assertCanPublishStoreProduct(
  storeId: string,
  productId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<void> {
  const rows = await sql`
    SELECT sp.visible, sp.archived_at,
           (SELECT COUNT(*)::int FROM product_variants v
             WHERE v.store_product_id = sp.id
               AND v.archived_at IS NULL AND v.is_active = TRUE) AS active_variants
      FROM store_products sp
     WHERE sp.id = ${productId}::uuid AND sp.store_id = ${storeId}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new BillingError('store_product_not_found', 'Producto no encontrado.', 404);
  if (row.visible === true || row.archived_at) return;

  const variants = toNumber(row.active_variants);
  await assertCanAddStoreSkus(storeId, variants > 0 ? variants : 1, sql);
}

/** Antes de crear un producto; los borradores no consumen. */
export async function assertCanCreateStoreProduct(
  storeId: string,
  input: { visible: boolean; activeVariants: number },
  sql: SqlClient = requirePlatformSql(),
): Promise<void> {
  if (!input.visible) return;
  const variants = Math.max(0, Math.trunc(input.activeVariants));
  await assertCanAddStoreSkus(storeId, variants > 0 ? variants : 1, sql);
}

/**
 * Antes de agregar una variante.
 *
 * Si el producto estaba contando por su SKU base (sin variantes activas), la
 * primera variante activa REEMPLAZA ese SKU (delta 0). A partir de la segunda,
 * cada variante suma 1.
 */
export async function assertCanAddStoreVariant(
  storeId: string,
  productId: string,
  input: { active: boolean },
  sql: SqlClient = requirePlatformSql(),
): Promise<void> {
  if (!input.active) return;
  const rows = await sql`
    SELECT sp.visible, sp.archived_at,
           (SELECT COUNT(*)::int FROM product_variants v
             WHERE v.store_product_id = sp.id
               AND v.archived_at IS NULL AND v.is_active = TRUE) AS active_variants
      FROM store_products sp
     WHERE sp.id = ${productId}::uuid AND sp.store_id = ${storeId}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new BillingError('store_product_not_found', 'Producto no encontrado.', 404);
  if (row.visible !== true || row.archived_at) return;

  const activeVariants = toNumber(row.active_variants);
  await assertCanAddStoreSkus(storeId, activeVariants === 0 ? 0 : 1, sql);
}

/** Antes de activar una variante inactiva (o desarchivar). */
export async function assertCanActivateStoreVariant(
  storeId: string,
  productId: string,
  variantId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<void> {
  const rows = await sql`
    SELECT sp.visible, sp.archived_at,
           v.is_active, v.archived_at AS variant_archived_at,
           (SELECT COUNT(*)::int FROM product_variants av
             WHERE av.store_product_id = sp.id
               AND av.archived_at IS NULL AND av.is_active = TRUE) AS active_variants
      FROM product_variants v
      JOIN store_products sp ON sp.id = v.store_product_id
     WHERE v.id = ${variantId}::uuid
       AND v.store_product_id = ${productId}::uuid
       AND v.store_id = ${storeId}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new BillingError('variant_not_found', 'Variante no encontrada.', 404);
  if (row.visible !== true || row.archived_at || row.variant_archived_at) return;
  if (row.is_active === true) return;

  const activeVariants = toNumber(row.active_variants);
  // Primera variante activa: reemplaza el SKU base. Siguientes: +1.
  await assertCanAddStoreSkus(storeId, activeVariants === 0 ? 0 : 1, sql);
}

/** Mantiene el estado `over_limit_at` sincronizado después de mutaciones. */
export async function refreshStoreOverLimit(
  storeId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE store_subscriptions ss
       SET over_limit_at = CASE
             WHEN COALESCE((SELECT sku_count FROM store_sku_usage WHERE store_id = ss.store_id), 0) > p.sku_limit
               THEN COALESCE(ss.over_limit_at, NOW())
             ELSE NULL
           END
      FROM plans p
     WHERE ss.plan_id = p.id
       AND ss.store_id = ${storeId}::uuid
     RETURNING ss.over_limit_at
  `;
  return !!rows[0]?.over_limit_at;
}
