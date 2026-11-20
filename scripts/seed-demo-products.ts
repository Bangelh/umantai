/**
 * scripts/seed-demo-products.ts — catálogo de DEMOSTRACIÓN para una tienda.
 *
 * Inserta productos de prueba en `store_products` y su stock inicial por el
 * ledger (`inventory_apply_movement`), igual que el panel del comerciante: el
 * stock nunca se escribe con UPDATE.
 *
 * Es idempotente: el upsert usa (store_id, slug) y cada movimiento lleva
 * `idempotency_key = demo:v1:<storeId>:<slug>`, así que re-ejecutarlo no
 * duplica productos ni stock.
 *
 * USO (contra la base que se indique, nunca lee .env.local):
 *
 *   PROD_DB_URL="postgres://..." npx tsx scripts/seed-demo-products.ts --store=juan-s-store --dry-run
 *   PROD_DB_URL="postgres://..." npx tsx scripts/seed-demo-products.ts --store=juan-s-store
 */

import { Client } from 'pg';

interface DemoProduct {
  slug: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  priceCents: number;
  unit: string;
  stock: number;
}

const DEMO_PRODUCTS: DemoProduct[] = [
  {
    slug: 'arroz-costeno-extra-largo-5kg',
    name: 'Arroz Costeño extra largo 5 kg',
    brand: 'Costeño',
    category: 'Abarrotes',
    description: 'Arroz extra largo, bolsa de 5 kg. Producto de demostración.',
    priceCents: 2450,
    unit: 'bolsa',
    stock: 18,
  },
  {
    slug: 'aceite-primor-vegetal-1l',
    name: 'Aceite Primor vegetal 1 L',
    brand: 'Primor',
    category: 'Abarrotes',
    description: 'Aceite vegetal de 1 litro. Producto de demostración.',
    priceCents: 1290,
    unit: 'botella',
    stock: 24,
  },
  {
    slug: 'leche-gloria-evaporada-400g',
    name: 'Leche Gloria evaporada 400 g',
    brand: 'Gloria',
    category: 'Abarrotes',
    description: 'Leche evaporada entera, tarro de 400 g. Producto de demostración.',
    priceCents: 450,
    unit: 'tarro',
    stock: 30,
  },
  {
    slug: 'inca-kola-1-5l',
    name: 'Inca Kola 1.5 L',
    brand: 'Inca Kola',
    category: 'Bebidas',
    description: 'Gaseosa de 1.5 litros. Producto de demostración.',
    priceCents: 750,
    unit: 'botella',
    stock: 36,
  },
  {
    slug: 'agua-san-mateo-625ml',
    name: 'Agua San Mateo 625 ml',
    brand: 'San Mateo',
    category: 'Bebidas',
    description: 'Agua de mesa sin gas, botella de 625 ml. Producto de demostración.',
    priceCents: 200,
    unit: 'botella',
    stock: 48,
  },
  {
    slug: 'detergente-bolivar-900g',
    name: 'Detergente Bolívar 900 g',
    brand: 'Bolívar',
    category: 'Limpieza',
    description: 'Detergente en polvo, bolsa de 900 g. Producto de demostración.',
    priceCents: 1190,
    unit: 'bolsa',
    stock: 15,
  },
  {
    slug: 'papel-higienico-elite-x4',
    name: 'Papel higiénico Elite x4',
    brand: 'Elite',
    category: 'Limpieza',
    description: 'Paquete de 4 rollos doble hoja. Producto de demostración.',
    priceCents: 990,
    unit: 'paquete',
    stock: 20,
  },
];

function parseArgs(argv: string[]): { storeSlug: string; dryRun: boolean } {
  let storeSlug = 'juan-s-store';
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--store=')) storeSlug = arg.slice('--store='.length).trim() || storeSlug;
    else throw new Error(`flag desconocido: ${arg}`);
  }
  return { storeSlug, dryRun };
}

/** Quita parámetros que `pg` no entiende y exige TLS sin verificación de CA. */
function connectionOptions(rawUrl: string): { connectionString: string; ssl: { rejectUnauthorized: boolean } } {
  const parsed = new URL(rawUrl);
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('pgbouncer');
  return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } };
}

async function main() {
  const { storeSlug, dryRun } = parseArgs(process.argv.slice(2));
  const url = (process.env.PROD_DB_URL ?? '').trim();
  if (!url) throw new Error('falta PROD_DB_URL (cadena de la base a sembrar).');

  const client = new Client({
    ...connectionOptions(url),
    application_name: 'umantai-seed-demo-products',
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  try {
    const storeRows = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM stores WHERE lower(slug) = lower($1) LIMIT 1',
      [storeSlug],
    );
    const store = storeRows.rows[0];
    if (!store) throw new Error(`tienda no encontrada: ${storeSlug}`);

    console.log(`🌱 Catálogo de demostración · ${store.name} (${store.id})${dryRun ? ' · DRY RUN' : ''}`);
    console.log(`   ${DEMO_PRODUCTS.length} productos · ${new Set(DEMO_PRODUCTS.map((p) => p.category)).size} categorías\n`);

    for (const product of DEMO_PRODUCTS) {
      const price = (product.priceCents / 100).toFixed(2);
      if (dryRun) {
        console.log(`  · ${product.name} — ${product.category} — S/ ${price} — stock ${product.stock}`);
        continue;
      }

      const upsert = await client.query<{ id: string }>(
        `INSERT INTO store_products
           (store_id, slug, name, brand, category, description, price_cents, currency, unit, visible)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'PEN', $8, TRUE)
         ON CONFLICT (store_id, slug) DO UPDATE SET
           name = EXCLUDED.name,
           brand = EXCLUDED.brand,
           category = EXCLUDED.category,
           description = EXCLUDED.description,
           price_cents = EXCLUDED.price_cents,
           currency = EXCLUDED.currency,
           unit = EXCLUDED.unit,
           visible = TRUE,
           archived_at = NULL,
           updated_at = NOW()
         RETURNING id`,
        [
          store.id,
          product.slug,
          product.name,
          product.brand,
          product.category,
          product.description,
          product.priceCents,
          product.unit,
        ],
      );
      const productId = upsert.rows[0]?.id;
      if (!productId) throw new Error(`no se pudo crear ${product.slug}`);

      await client.query(
        `SELECT inventory_apply_movement(
           $1, '', 'receipt'::inventory_movement_type,
           $2, 0, 'MAIN', NULL, NULL,
           'demo catalog seed', 'seed-demo-products', $3, $4::uuid
         )`,
        [product.slug, product.stock, `demo:v1:${store.id}:${product.slug}`, store.id],
      );

      console.log(`  ✓ ${product.name} — ${product.category} — S/ ${price} — stock ${product.stock}`);
    }

    console.log(`\n${dryRun ? '🧪 DRY RUN — no se escribió nada' : '✅ Catálogo cargado'}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
