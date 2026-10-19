/**
 * scripts/migrate-legacy-catalog.ts
 *
 * Backfill controlado del catálogo de fase 1:
 *   `lib/products.ts` → `master_products` + `store_products` de la tienda
 *   legacy `umantai` (UUID fijo, inactiva).
 *
 * NO borra `lib/products.ts` ni `product_overrides`. Se puede ejecutar varias
 * veces: usa claves únicas y actualiza solo los campos editoriales.
 *
 * Uso (staging):
 *   railway run --service web node --import tsx scripts/migrate-legacy-catalog.ts
 */

import { getDatabaseUrl } from '../lib/db';
import { createSqlClient } from '../lib/db-driver.server';
import { DEFAULT_STORE_ID, DEFAULT_STORE_SLUG } from '../lib/stores.server';
import { buildOptionSchema, cartesianVariants, generateSku, variantKeyFromOptionValues } from '../lib/catalog';
import { getProductOptions, baseProductsData } from '../lib/products';

interface Summary {
  masters: number;
  storeProducts: number;
  variants: number;
  skippedNoMaster: number;
}

async function main() {
  const url = getDatabaseUrl();
  if (!url) throw new Error('Falta la URL de PostgreSQL.');
  const sql = createSqlClient(url);

  const storeRows = await sql`
    SELECT id, slug FROM stores
     WHERE id = ${DEFAULT_STORE_ID}::uuid OR lower(slug) = ${DEFAULT_STORE_SLUG}
     ORDER BY (id = ${DEFAULT_STORE_ID}::uuid) DESC
     LIMIT 1
  `;
  const store = storeRows[0] as { id?: string; slug?: string } | undefined;
  if (!store?.id) {
    throw new Error('No existe la tienda legacy. Aplica la migración 011 primero.');
  }

  const summary: Summary = { masters: 0, storeProducts: 0, variants: 0, skippedNoMaster: 0 };

  for (const product of baseProductsData) {
    // 1) MasterProduct. Si ya existe la identidad nombre+marca, se reutiliza.
    await sql`
      INSERT INTO master_products (
        slug, name, brand, category, description, image_url, active, metadata
      ) VALUES (
        ${product.slug}, ${product.name}, ${product.brand || null}, ${product.category},
        ${product.description}, ${product.images?.[0] ?? null}, TRUE,
        ${JSON.stringify({ source: 'legacy-catalog-migration' })}::jsonb
      )
      ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name,
            brand = EXCLUDED.brand,
            category = EXCLUDED.category,
            description = EXCLUDED.description,
            image_url = COALESCE(EXCLUDED.image_url, master_products.image_url),
            updated_at = NOW()
    `;

    const masterRows = await sql`
      SELECT id FROM master_products
       WHERE slug = ${product.slug} OR (
         normalized_name = normalize_search_text(${product.name})
         AND normalize_search_text(COALESCE(brand, '')) = normalize_search_text(${product.brand || ''})
       )
       ORDER BY (slug = ${product.slug}) DESC
       LIMIT 1
    `;
    const masterId = (masterRows[0] as { id?: string } | undefined)?.id;
    if (!masterId) {
      summary.skippedNoMaster += 1;
      continue;
    }
    summary.masters += 1;

    // 2) StoreProduct de la tienda legacy. El precio es snapshots de fase 1.
    const priceCents = Math.round(Number(product.price) * 100);
    await sql`
      INSERT INTO store_products (
        store_id, master_product_id, slug, name, brand, category, description,
        image_url, price_cents, currency, unit, visible, metadata
      ) VALUES (
        ${store.id}::uuid, ${masterId}::uuid, ${product.slug}, ${product.name},
        ${product.brand || null}, ${product.category}, ${product.description},
        ${product.images?.[0] ?? null}, ${priceCents}, 'PEN', 'unidad', TRUE,
        ${JSON.stringify({ source: 'legacy-catalog-migration' })}::jsonb
      )
      ON CONFLICT (store_id, slug) DO UPDATE
        SET master_product_id = EXCLUDED.master_product_id,
            name = EXCLUDED.name,
            brand = EXCLUDED.brand,
            category = EXCLUDED.category,
            description = EXCLUDED.description,
            image_url = COALESCE(EXCLUDED.image_url, store_products.image_url),
            price_cents = EXCLUDED.price_cents,
            updated_at = NOW()
      RETURNING id
    `;
    summary.storeProducts += 1;

    const storeProductRows = await sql`
      SELECT id FROM store_products
       WHERE store_id = ${store.id}::uuid AND slug = ${product.slug}
       LIMIT 1
    `;
    const storeProductId = (storeProductRows[0] as { id?: string } | undefined)?.id;
    if (!storeProductId) continue;

    // 3) Variantes legacy. `inventory` ya tiene las filas con el variant_key
    // histórico; aquí solo se declara qué combinaciones son vendibles. No se
    // crea stock (sería duplicarlo).
    const options = getProductOptions(product);
    if (options.length === 0) continue;
    const schema = buildOptionSchema(
      cartesianVariants(
        options.map((option) => ({ name: option.name, values: [...option.values] })),
      ).map((optionValues) => ({ optionValues })),
    );
    const combinations = cartesianVariants(schema);

    for (const [index, optionValues] of combinations.entries()) {
      const variantKey = variantKeyFromOptionValues(optionValues);
      const sku = generateSku(product.slug, optionValues).slice(0, 74) + `-${index + 1}`;
      await sql`
        INSERT INTO product_variants (
          store_id, store_product_id, variant_key, sku, option_values, is_active
        ) VALUES (
          ${store.id}::uuid, ${storeProductId}::uuid, ${variantKey}, ${sku},
          ${JSON.stringify(optionValues)}::jsonb, TRUE
        )
        ON CONFLICT (store_product_id, variant_key) DO NOTHING
      `;
      summary.variants += 1;
    }

    await sql`
      UPDATE store_products
         SET option_schema = ${JSON.stringify(schema)}::jsonb
       WHERE id = ${storeProductId}::uuid
    `;
  }

  console.info(
    `[legacy-catalog] masters=${summary.masters} storeProducts=${summary.storeProducts} ` +
      `variants=${summary.variants} skipped=${summary.skippedNoMaster}`,
  );
}

main().catch((error) => {
  console.error('[legacy-catalog] falló la migración', error);
  process.exitCode = 1;
});
