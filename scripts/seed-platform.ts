/**
 * scripts/seed-platform.ts — seed del buscador local (idempotente).
 *
 * Crea 4 tiendas de rubros distintos con coordenadas pensadas para probar
 * radios de 1/5/10/20 km desde Lima Centro (-12.0464, -77.0428):
 *
 *   Bodega La Esquina   abarrotes   ~0,5 km
 *   Hilos & Estilo      ropa        ~4,4 km
 *   Telas del Sur       telas       ~9,5 km
 *   Ferretería Central  ferretería  ~15,1 km
 *
 * Productos suficientes para `arroz`, `polo`, `tela`, `martillo`, `zapatos`.
 * Re-ejecutarlo NO duplica tiendas ni stock (usa las claves únicas y la
 * idempotencia de `inventory_apply_movement`).
 *
 * Uso (staging, con las variables de Railway inyectadas):
 *   railway run --service web node --import tsx scripts/seed-platform.ts
 *
 * Opcional: SEED_OWNER_EMAIL=tu@correo hace owner de las 4 tiendas a un usuario
 * ya registrado, para probar el panel de comerciante.
 */

import { getDatabaseUrl } from '../lib/db';
import { createSqlClient } from '../lib/db-driver.server';
import { buildOptionSchema, generateSku, variantKeyFromOptionValues } from '../lib/catalog';

interface SeedVariant {
  optionValues: Record<string, string>;
  priceCents?: number | null;
  stock: number;
}

interface SeedProduct {
  slug: string;
  masterSlug: string | null;
  name: string;
  brand: string | null;
  category: string;
  priceCents: number;
  unit: string;
  stock: number;
  variants?: SeedVariant[];
}

interface SeedStore {
  slug: string;
  name: string;
  category: string;
  description: string;
  address: string;
  district: string;
  city: string;
  latitude: number;
  longitude: number;
  products: SeedProduct[];
}

const STORES: SeedStore[] = [
  {
    slug: 'bodega-la-esquina',
    name: 'Bodega La Esquina',
    category: 'abarrotes',
    description: 'Abarrotes, granos y productos de despensa para el día a día.',
    address: 'Av. Arequipa 1234',
    district: 'Lima Centro',
    city: 'Lima',
    latitude: -12.05,
    longitude: -77.045,
    products: [
      { slug: 'arroz-costeno-5kg', masterSlug: 'arroz', name: 'Arroz costeño 5 kg', brand: 'Costeño', category: 'abarrotes', priceCents: 2450, unit: 'unidad', stock: 40 },
      { slug: 'arroz-granel', masterSlug: 'arroz', name: 'Arroz a granel', brand: null, category: 'abarrotes', priceCents: 1200, unit: 'kg', stock: 0, variants: [
        { optionValues: { presentacion: '1 kg' }, priceCents: 1200, stock: 30 },
        { optionValues: { presentacion: '5 kg' }, priceCents: 5500, stock: 15 },
      ] },
      { slug: 'aceite-primor-1l', masterSlug: 'aceite', name: 'Aceite Primor 1 L', brand: 'Primor', category: 'abarrotes', priceCents: 1290, unit: 'unidad', stock: 25 },
      { slug: 'leche-evaporada-tarrito', masterSlug: null, name: 'Leche evaporada tarro 400 g', brand: 'Gloria', category: 'abarrotes', priceCents: 430, unit: 'unidad', stock: 0 },
      { slug: 'frijol-canario-1kg', masterSlug: null, name: 'Frijol canario 1 kg', brand: null, category: 'abarrotes', priceCents: 890, unit: 'kg', stock: 18 },
    ],
  },
  {
    slug: 'hilos-y-estilo',
    name: 'Hilos & Estilo',
    category: 'ropa',
    description: 'Ropa urbana y básicos de algodón para todos los días.',
    address: 'Calle Los Olivos 456',
    district: 'San Isidro',
    city: 'Lima',
    latitude: -12.085,
    longitude: -77.05,
    products: [
      { slug: 'polo-basico-algodon', masterSlug: 'polo', name: 'Polo básico algodón', brand: 'Polo Club', category: 'ropa', priceCents: 3990, unit: 'unidad', stock: 18 },
      { slug: 'polo-tallas-colores', masterSlug: 'polo', name: 'Polo algodón tallas y colores', brand: 'Polo Club', category: 'ropa', priceCents: 4290, unit: 'unidad', stock: 0, variants: [
        { optionValues: { talla: 'S', color: 'negro' }, priceCents: 4290, stock: 8 },
        { optionValues: { talla: 'S', color: 'blanco' }, priceCents: 4290, stock: 6 },
        { optionValues: { talla: 'M', color: 'negro' }, priceCents: 4390, stock: 10 },
        { optionValues: { talla: 'M', color: 'blanco' }, priceCents: 4390, stock: 4 },
      ] },
      { slug: 'casaca-denim', masterSlug: null, name: 'Casaca denim', brand: 'Denim Co.', category: 'ropa', priceCents: 12900, unit: 'unidad', stock: 7 },
      { slug: 'zapatillas-urbanas', masterSlug: 'zapatos', name: 'Zapatillas urbanas', brand: 'Andes', category: 'calzado', priceCents: 15900, unit: 'unidad', stock: 5 },
      { slug: 'polo-manga-larga', masterSlug: 'polo', name: 'Polo manga larga', brand: 'Polo Club', category: 'ropa', priceCents: 4590, unit: 'unidad', stock: 0 },
    ],
  },
  {
    slug: 'telas-del-sur',
    name: 'Telas del Sur',
    category: 'telas',
    description: 'Telas por metro para confección: lino, seda y algodón.',
    address: 'Av. Santiago de Surco 789',
    district: 'Santiago de Surco',
    city: 'Lima',
    latitude: -12.13,
    longitude: -77.03,
    products: [
      { slug: 'tela-lino', masterSlug: 'tela', name: 'Tela de lino', brand: null, category: 'telas', priceCents: 1850, unit: 'metro', stock: 30 },
      { slug: 'tela-lino-color-ancho', masterSlug: 'tela', name: 'Tela de lino por color y ancho', brand: null, category: 'telas', priceCents: 1950, unit: 'metro', stock: 0, variants: [
        { optionValues: { color: 'rojo', ancho: '1.5 m' }, priceCents: 1950, stock: 20 },
        { optionValues: { color: 'rojo', ancho: '2 m' }, priceCents: 2400, stock: 10 },
        { optionValues: { color: 'azul', ancho: '1.5 m' }, priceCents: 1950, stock: 14 },
        { optionValues: { color: 'azul', ancho: '2 m' }, priceCents: 2400, stock: 6 },
      ] },
      { slug: 'tela-seda', masterSlug: 'tela', name: 'Tela de seda', brand: null, category: 'telas', priceCents: 4200, unit: 'metro', stock: 12 },
      { slug: 'tela-algodon', masterSlug: 'tela', name: 'Tela de algodón', brand: null, category: 'telas', priceCents: 1500, unit: 'metro', stock: 60 },
    ],
  },
  {
    slug: 'ferreteria-central',
    name: 'Ferretería Central',
    category: 'ferretería',
    description: 'Herramientas y materiales para obra y hogar.',
    address: 'Av. Los Héroes 321',
    district: 'Ate',
    city: 'Lima',
    latitude: -12.18,
    longitude: -77.02,
    products: [
      { slug: 'martillo-pro', masterSlug: 'martillo', name: 'Martillo profesional', brand: 'Truper', category: 'ferretería', priceCents: 3500, unit: 'unidad', stock: 14 },
      { slug: 'botas-seguridad', masterSlug: 'zapatos', name: 'Botas de seguridad', brand: 'Andes', category: 'calzado', priceCents: 8900, unit: 'unidad', stock: 9 },
      { slug: 'taladro-percutor', masterSlug: null, name: 'Taladro percutor 650 W', brand: 'Bosch', category: 'ferretería', priceCents: 24900, unit: 'unidad', stock: 4 },
      { slug: 'cinta-metrica-5m', masterSlug: null, name: 'Cinta métrica 5 m', brand: 'Stanley', category: 'ferretería', priceCents: 1990, unit: 'unidad', stock: 22 },
    ],
  },
];

const MASTER_PRODUCTS: Array<{ slug: string; name: string; brand: string | null; category: string }> = [
  { slug: 'arroz', name: 'Arroz', brand: null, category: 'abarrotes' },
  { slug: 'aceite', name: 'Aceite', brand: null, category: 'abarrotes' },
  { slug: 'polo', name: 'Polo', brand: null, category: 'ropa' },
  { slug: 'zapatos', name: 'Zapatos', brand: null, category: 'calzado' },
  { slug: 'tela', name: 'Tela', brand: null, category: 'telas' },
  { slug: 'martillo', name: 'Martillo', brand: null, category: 'ferretería' },
];

export async function seedPlatform(): Promise<void> {
  if (!getDatabaseUrl()) {
    throw new Error('Falta la URL de PostgreSQL (POSTGRES_URL_NON_POOLING / DATABASE_URL).');
  }

  const sql = createSqlClient(getDatabaseUrl()!);
  const ownerEmail = (process.env.SEED_OWNER_EMAIL ?? '').trim().toLowerCase();
  const summary: Array<{ store: string; products: number; linkedOwner: boolean }> = [];

  for (const master of MASTER_PRODUCTS) {
    await sql`
      INSERT INTO master_products (slug, name, brand, category, active)
      VALUES (${master.slug}, ${master.name}, ${master.brand}, ${master.category}, TRUE)
      ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name,
            brand = EXCLUDED.brand,
            category = EXCLUDED.category,
            active = TRUE
    `;
  }

  for (const store of STORES) {
    const storeRows = await sql`
      INSERT INTO stores (
        name, slug, description, category, address, district, city,
        latitude, longitude, active, approved_at, metadata
      ) VALUES (
        ${store.name}, ${store.slug}, ${store.description}, ${store.category},
        ${store.address}, ${store.district}, ${store.city},
        ${store.latitude}::float8, ${store.longitude}::float8,
        TRUE, NOW(), ${JSON.stringify({ source: 'seed-platform' })}::jsonb
      )
      ON CONFLICT (lower(slug)) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            category = EXCLUDED.category,
            address = EXCLUDED.address,
            district = EXCLUDED.district,
            city = EXCLUDED.city,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            active = TRUE,
            approved_at = COALESCE(stores.approved_at, NOW())
      RETURNING id
    `;

    const storeId = String(storeRows[0]?.id);
    if (!storeId) throw new Error(`No se pudo sembrar la tienda ${store.slug}`);

    let linkedOwner = false;
    if (ownerEmail) {
      const linked = await sql`
        INSERT INTO store_members (store_id, user_id, role)
        SELECT ${storeId}::uuid, u.id, 'owner'
          FROM users u
         WHERE lower(u.email) = ${ownerEmail}
        ON CONFLICT (store_id, user_id) DO NOTHING
        RETURNING user_id
      `;
      linkedOwner = linked.length > 0;
    }

    for (const product of store.products) {
      const variants = product.variants ?? [];
      const schema = buildOptionSchema(variants);
      const productRows = await sql`
        INSERT INTO store_products (
          store_id, master_product_id, slug, name, brand, category,
          description, price_cents, unit, visible, option_schema
        ) VALUES (
          ${storeId}::uuid,
          (SELECT id FROM master_products WHERE slug = ${product.masterSlug}),
          ${product.slug}, ${product.name}, ${product.brand}, ${product.category},
          ${`${product.name} — ${store.name}`}, ${product.priceCents}, ${product.unit}, TRUE,
          ${JSON.stringify(schema)}::jsonb
        )
        ON CONFLICT (store_id, slug) DO UPDATE
          SET name = EXCLUDED.name,
              brand = EXCLUDED.brand,
              category = EXCLUDED.category,
              price_cents = EXCLUDED.price_cents,
              unit = EXCLUDED.unit,
              visible = TRUE,
              archived_at = NULL,
              option_schema = EXCLUDED.option_schema,
              master_product_id = EXCLUDED.master_product_id
        RETURNING id
      `;
      const productId = productRows[0]?.id;
      if (!productId) throw new Error(`No se pudo sembrar ${store.slug}/${product.slug}`);

      if (variants.length > 0) {
        for (const [index, variant] of variants.entries()) {
          const variantKey = variantKeyFromOptionValues(variant.optionValues);
          const sku = generateSku(product.slug, variant.optionValues).slice(0, 70) + `-${index + 1}`;
          await sql`
            INSERT INTO product_variants (
              store_id, store_product_id, variant_key, sku, option_values, price_cents, is_active
            ) VALUES (
              ${storeId}::uuid, ${String(productId)}::uuid, ${variantKey}, ${sku},
              ${JSON.stringify(variant.optionValues)}::jsonb, ${variant.priceCents ?? null}, TRUE
            )
            ON CONFLICT (store_product_id, variant_key) DO UPDATE
              SET sku = EXCLUDED.sku,
                  price_cents = EXCLUDED.price_cents,
                  is_active = TRUE,
                  archived_at = NULL,
                  updated_at = NOW()
          `;

          if (variant.stock > 0) {
            await sql`
              SELECT inventory_apply_movement(
                ${product.slug}, ${variantKey}, 'receipt'::inventory_movement_type,
                ${variant.stock}, 0, 'MAIN', NULL, NULL,
                'seed-platform', 'seed',
                ${`seed-v1:${storeId}:${product.slug}:${variantKey}`}, ${storeId}::uuid
              )
            `;
          }
        }
      } else if (product.stock > 0) {
        // `receipt` es idempotente por clave: re-ejecutar el seed no suma stock.
        await sql`
          SELECT inventory_apply_movement(
            ${product.slug}, '', 'receipt'::inventory_movement_type,
            ${product.stock}, 0, 'MAIN', NULL, NULL,
            'seed-platform', 'seed', ${`seed-v1:${storeId}:${product.slug}`},
            ${storeId}::uuid
          )
        `;
      }
    }

    summary.push({ store: store.slug, products: store.products.length, linkedOwner });
  }

  const availability = await sql`
    SELECT s.slug,
           COUNT(sp.id)::int AS products,
           COALESCE(SUM(inv.available), 0)::int AS available
      FROM stores s
      LEFT JOIN store_products sp ON sp.store_id = s.id AND sp.visible = TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(i.quantity_available)::int AS available
          FROM inventory i
         WHERE i.store_id = sp.store_id AND i.product_slug = sp.slug AND i.is_active
      ) inv ON TRUE
     WHERE s.slug = ANY(${STORES.map((store) => store.slug)}::text[])
     GROUP BY s.slug
     ORDER BY s.slug
  `;

  console.info(
    JSON.stringify(
      {
        ok: true,
        ownerEmail: ownerEmail || null,
        stores: summary,
        availability,
      },
      null,
      2,
    ),
  );
}

const isDirectRun =
  typeof process.argv[1] === 'string' && /seed-platform\.(ts|js|mjs)$/.test(process.argv[1]);

if (isDirectRun) {
  seedPlatform().catch((error) => {
    console.error('[seed-platform] falló', error);
    process.exitCode = 1;
  });
}
