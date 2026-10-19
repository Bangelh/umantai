/**
 * tests/multi-store-catalog.integration.test.ts — PostgreSQL REAL (efímero).
 *
 * Cubre la fase MULTI-STORE CATALOG:
 *   · MasterProduct create / duplicate / search / archive
 *   · StoreProduct desde maestro, propio, edición y archivo lógico
 *   · Variantes genéricas, SKU único, inventario independiente
 *   · Búsqueda con acentos, geo y sin duplicar productos
 *   · Checkout: tienda derivada, cross-store, precio server-side, variantes,
 *     visibilidad, tienda inactiva y stock insuficiente
 *   · Historial: archivar un producto no rompe el pedido anterior
 *   · Storage: MIME real, tamaño máximo, lectura y aislamiento por tienda
 *
 * Nunca lee DATABASE_URL ni toca staging/Producción.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import type { CheckoutRequestLine } from '../lib/store-catalog.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';

type Stores = typeof import('../lib/stores.server');
type Catalog = typeof import('../lib/store-catalog.server');
type Master = typeof import('../lib/master.server');
type Storage = typeof import('../lib/storage.server');
type Commerce = typeof import('../lib/commerce.server');
type Platform = typeof import('../lib/platform-db.server');

let database: EmbeddedTestDatabase;
let stores: Stores;
let catalog: Catalog;
let master: Master;
let storage: Storage;
let commerce: Commerce;
let platform: Platform;

const BASE = { latitude: -12.0464, longitude: -77.0428 };

interface TestStore {
  id: string;
  slug: string;
  name: string;
}

const userA = { id: `cat-a-${randomUUID()}` };
const userB = { id: `cat-b-${randomUUID()}` };
const storeA = {} as TestStore;
const storeB = {} as TestStore;

let maestroArrozId = '';
let productoVariantesAId = '';
let varianteMId = '';
let ownOrderId = '';

before(async () => {
  database = await startTestDatabase();

  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  delete process.env.VERCEL_ENV;

  stores = await import('../lib/stores.server');
  catalog = await import('../lib/store-catalog.server');
  master = await import('../lib/master.server');
  storage = await import('../lib/storage.server');
  commerce = await import('../lib/commerce.server');
  platform = await import('../lib/platform-db.server');

  const sql = platform.requirePlatformSql();
  await sql`
    INSERT INTO users (id, name, email)
    VALUES (${userA.id}, 'Merchant A', ${`${userA.id}@example.invalid`}),
           (${userB.id}, 'Merchant B', ${`${userB.id}@example.invalid`})
  `;

  Object.assign(
    storeA,
    await makeStore(userA.id, 'Bodega Catálogo A', 'bodega-catalogo-a', -12.05, -77.045),
  );
  Object.assign(
    storeB,
    await makeStore(userB.id, 'Tienda Catálogo B', 'tienda-catalogo-b', -12.085, -77.05),
  );
});

after(async () => {
  await closeDbPools();
  if (database) await database.stop();
});

async function makeStore(
  ownerUserId: string,
  name: string,
  slug: string,
  latitude: number,
  longitude: number,
): Promise<TestStore> {
  const created = await stores.createStoreForOwner({
    ownerUserId,
    name,
    slug,
    category: 'test',
    address: `Av. Test ${slug}`,
    latitude,
    longitude,
  });

  const sql = platform.requirePlatformSql();
  await sql`
    UPDATE stores
       SET active = TRUE, approved_at = NOW()
     WHERE id = ${created.id}::uuid
  `;
  return { id: created.id, slug: created.slug, name: created.name };
}

// =============================================================================
//  MASTER CATALOG
// =============================================================================

test('master: crea, normaliza búsqueda y evita duplicados por nombre+marca', async () => {
  const arroz = await master.createMasterProduct({
    name: 'Arroz Costeño',
    brand: 'Costeño',
    category: 'abarrotes',
    description: 'Arroz extra largo',
  });
  maestroArrozId = arroz.id;
  assert.equal(arroz.name, 'Arroz Costeño');
  assert.equal(arroz.brand, 'Costeño');

  await assert.rejects(
    master.createMasterProduct({ name: '  arroz   costeño ', brand: 'COSTEÑO' }),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'master_product_exists',
  );

  const byName = await master.listMasterProducts({ q: 'arroz costeno' });
  assert.equal(byName.total, 1);
  assert.equal(byName.products[0]?.id, arroz.id);

  const byBrand = await master.listMasterProducts({ q: 'costeno' });
  assert.ok(byBrand.products.some((product) => product.id === arroz.id));
});

test('master: permite productos no alimentarios y archiva sin borrar', async () => {
  const martillo = await master.createMasterProduct({
    name: 'Martillo de acero',
    category: 'ferretería',
    attributes: { material: 'acero', peso_kg: 1.2 },
  });
  assert.deepEqual(martillo.attributes, { material: 'acero', peso_kg: 1.2 });

  const archived = await master.updateMasterProduct(martillo.id, { archived: true });
  assert.ok(archived.archivedAt);

  const visible = await master.listMasterProducts({ q: 'martillo' });
  assert.equal(visible.total, 0);

  const all = await master.listMasterProducts({ q: 'martillo', includeArchived: true });
  assert.equal(all.total, 1);
  assert.ok(all.products[0]?.archivedAt);
});

// =============================================================================
//  STORE PRODUCT + VARIANTS
// =============================================================================

test('store product: se crea desde el maestro con precio propio y stock inicial', async () => {
  const created = await catalog.createStoreProductCatalog(userA.id, storeA.id, {
    masterProductId: maestroArrozId,
    priceCents: 2450,
    initialStock: 12,
    visible: true,
  });
  assert.equal(String(created.name), 'Arroz Costeño');
  assert.equal(String(created.master_product_id), maestroArrozId);
  assert.equal(Number(created.price_cents), 2450);
  assert.equal(String(created.slug), 'arroz-costeno');

  const products = await stores.listStoreProducts(userA.id, storeA.id);
  const product = products.find((item) => item.slug === 'arroz-costeno');
  assert.ok(product);
  assert.equal(product.available, 12);
  assert.equal(product.inStock, true);
});

test('store product: edita precio/visibilidad y conserva el slug', async () => {
  const created = await catalog.createStoreProductCatalog(userA.id, storeA.id, {
    name: 'Producto editable',
    category: 'pruebas',
    priceCents: 900,
    visible: true,
  });
  const productId = String(created.id);
  const slug = String(created.slug);

  await catalog.updateStoreProductCatalog(userA.id, storeA.id, productId, {
    name: 'Producto editable v2',
    priceCents: 1200,
    visible: false,
  });

  const updated = (await stores.listStoreProducts(userA.id, storeA.id)).find(
    (product) => product.id === productId,
  );
  assert.ok(updated);
  assert.equal(updated.name, 'Producto editable v2');
  assert.equal(updated.priceCents, 1200);
  assert.equal(updated.visible, false);
  assert.equal(updated.slug, slug, 'editar no cambia la URL pública');

  await catalog.updateStoreProductCatalog(userA.id, storeA.id, productId, { visible: true });
});

test('variants: ejes genéricos, SKU estable y stock independiente por combinación', async () => {
  const created = await catalog.createStoreProductCatalog(userA.id, storeA.id, {
    name: 'Polo algodón',
    brand: 'Polo Club',
    category: 'ropa',
    priceCents: 4290,
    variants: [
      { optionValues: { talla: 'M', color: 'negro' }, priceCents: 4390, initialStock: 5 },
      { optionValues: { talla: 'L', color: 'negro' }, initialStock: 2 },
      { optionValues: { talla: 'M', color: 'blanco' }, initialStock: 0 },
    ],
  });
  productoVariantesAId = String(created.id);

  const products = await stores.listStoreProducts(userA.id, storeA.id);
  const product = products.find((item) => item.id === productoVariantesAId);
  assert.ok(product);
  assert.equal(product.variants.length, 3);
  assert.deepEqual(
    product.optionSchema.map((axis) => axis.name).sort(),
    ['color', 'talla'],
  );

  const negroM = product.variants.find(
    (variant) => variant.optionValues.talla === 'M' && variant.optionValues.color === 'negro',
  );
  const negroL = product.variants.find(
    (variant) => variant.optionValues.talla === 'L' && variant.optionValues.color === 'negro',
  );
  assert.ok(negroM && negroL);
  varianteMId = negroM.id;
  assert.equal(negroM.available, 5);
  assert.equal(negroL.available, 2);
  assert.notEqual(negroM.sku, negroL.sku);
  assert.equal(negroM.priceCents, 4390);
  assert.equal(negroL.priceCents, null);
  assert.equal(product.available, 7);
});

test('variants: rechaza ejes mezclados y SKU duplicado', async () => {
  await assert.rejects(
    catalog.addStoreVariant(userA.id, storeA.id, productoVariantesAId, {
      optionValues: { talla: 'S' },
      initialStock: 1,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === 'invalid_variant',
  );

  const current = (await stores.listStoreProducts(userA.id, storeA.id)).find(
    (item) => item.id === productoVariantesAId,
  );
  const firstSku = current?.variants[0]?.sku;
  assert.ok(firstSku);

  await assert.rejects(
    catalog.addStoreVariant(userA.id, storeA.id, productoVariantesAId, {
      optionValues: { talla: 'S', color: 'negro' },
      sku: firstSku,
      initialStock: 0,
    }),
    (error: unknown) => (error as { code?: string }).code === 'variant_sku_taken',
  );
});

test('variants: ajustar stock de una variante NO toca las demás', async () => {
  const stock = await catalog.adjustStoreVariantStock(
    userA.id,
    storeA.id,
    productoVariantesAId,
    'color:negro|talla:m',
    3,
    'Reposición de prueba',
  );
  assert.equal(stock.onHand, 8);
  assert.equal(stock.available, 8);

  const product = (await stores.listStoreProducts(userA.id, storeA.id)).find(
    (item) => item.id === productoVariantesAId,
  );
  const negroM = product?.variants.find((variant) => variant.id === varianteMId);
  const negroL = product?.variants.find(
    (variant) => variant.optionValues.talla === 'L' && variant.optionValues.color === 'negro',
  );
  assert.equal(negroM?.available, 8);
  assert.equal(negroL?.available, 2);
});

test('tenant security: B no lee ni escribe el catálogo de A', async () => {
  await assert.rejects(
    stores.listStoreProducts(userB.id, storeA.id),
    (error: unknown) => (error as { code?: string }).code === 'store_forbidden',
  );
  await assert.rejects(
    catalog.createStoreProductCatalog(userB.id, storeA.id, {
      name: 'Intruso',
      priceCents: 1,
    }),
    (error: unknown) => (error as { code?: string }).code === 'store_forbidden',
  );
  await assert.rejects(
    catalog.updateStoreProductCatalog(userB.id, storeA.id, productoVariantesAId, {
      priceCents: 1,
    }),
    (error: unknown) => (error as { code?: string }).code === 'store_forbidden',
  );
  await assert.rejects(
    catalog.adjustStoreVariantStock(userB.id, storeA.id, productoVariantesAId, '', 1, 'intruso'),
    (error: unknown) => (error as { code?: string }).code === 'store_forbidden',
  );
});

test('store product: producto propio no se promueve al maestro', async () => {
  const created = await catalog.createStoreProductCatalog(userB.id, storeB.id, {
    name: 'Tela lino rojo',
    category: 'telas',
    priceCents: 1950,
    initialStock: 4,
  });
  assert.equal(created.master_product_id, null);
  assert.equal(String(created.store_id), storeB.id);

  const result = await master.listMasterProducts({ q: 'tela lino rojo' });
  assert.equal(result.total, 0);
});

// =============================================================================
//  SEARCH + PUBLIC STOREFRONT
// =============================================================================

test('search: un solo resultado por StoreProduct, acentos y precio de variante', async () => {
  const result = await stores.searchDiscovery({
    q: 'arroz costeno',
    location: BASE,
    radiusKm: 5,
    limit: 20,
    offset: 0,
  });
  const matches = result.products.filter((product) => product.productSlug === 'arroz-costeno');
  assert.equal(matches.length, 1, 'el producto no debe duplicarse');
  assert.equal(matches[0]?.storeId, storeA.id);
  assert.ok((matches[0]?.distanceKm ?? 99) <= 5);

  const polos = await stores.searchDiscovery({
    q: 'polo',
    location: BASE,
    radiusKm: 5,
    limit: 20,
    offset: 0,
  });
  const poloA = polos.products.find((product) => product.storeId === storeA.id);
  assert.ok(poloA);
  assert.equal(poloA.variantCount, 3);
  assert.equal(poloA.hasVariants, true);
  assert.equal(poloA.priceCents, 4290, 'el precio mostrado es el mínimo de las variantes');
  assert.equal(poloA.available, 10, 'suma solo el stock de variantes vendibles');
});

test('search: producto no publicado o archivado no aparece', async () => {
  const archived = await catalog.createStoreProductCatalog(userA.id, storeA.id, {
    name: 'Producto temporal',
    priceCents: 100,
    visible: true,
  });
  await catalog.updateStoreProductCatalog(userA.id, storeA.id, String(archived.id), {
    archived: true,
  });

  const result = await stores.searchDiscovery({
    q: 'producto temporal',
    location: BASE,
    radiusKm: 5,
    limit: 20,
    offset: 0,
  });
  assert.equal(result.products.length, 0);
});

test('public storefront: no expone productos archivados', async () => {
  const storefront = await stores.getStorefront(storeA.slug);
  assert.ok(storefront);
  assert.ok(storefront.products.every((product) => product.name !== 'Producto temporal'));
  const polo = storefront.products.find((product) => product.name === 'Polo algodón');
  assert.equal(polo?.variants.length, 3);
});

// =============================================================================
//  CHECKOUT ENFORCEMENT
// =============================================================================

async function resolve(storeSlug: string, lines: CheckoutRequestLine[]) {
  return catalog.resolveStoreCheckout(storeSlug, lines);
}

test('checkout: la tienda y el precio salen del servidor, no del navegador', async () => {
  const resolved = await resolve(storeA.slug, [
    { productSlug: 'arroz-costeno', quantity: 1 },
  ]);
  assert.equal(resolved.store.id, storeA.id);
  assert.equal(resolved.lines[0]?.unitPrice, 24.5);
  assert.equal(resolved.lines[0]?.variantKey, '');
});

test('checkout: precio de la variante y rechazo de una combinación inexistente', async () => {
  const resolved = await resolve(storeA.slug, [
    {
      productSlug: 'polo-algodon',
      quantity: 1,
      variant: { talla: 'M', color: 'negro' },
    },
  ]);
  assert.equal(resolved.lines[0]?.unitPrice, 43.9);
  assert.equal(resolved.lines[0]?.variantKey, 'color:negro|talla:m');
  assert.ok(resolved.lines[0]?.variantSku);

  await assert.rejects(
    resolve(storeA.slug, [
      { productSlug: 'polo-algodon', quantity: 1, variant: { talla: 'XXL', color: 'negro' } },
    ]),
    (error: unknown) => (error as { code?: string }).code === 'invalid_variant',
  );
  await assert.rejects(
    resolve(storeA.slug, [{ productSlug: 'arroz-costeno', quantity: 1, variant: { talla: 'M' } }]),
    (error: unknown) => (error as { code?: string }).code === 'invalid_variant',
  );
});

test('checkout: rechaza carritos cross-store, incluso si el hint contradice la línea', async () => {
  await assert.rejects(
    resolve(storeA.slug, [
      { productSlug: 'arroz-costeno', storeSlug: storeA.slug, quantity: 1 },
      { productSlug: 'tela-lino-rojo', storeSlug: storeB.slug, quantity: 1 },
    ]),
    (error: unknown) => (error as { code?: string }).code === 'mixed_store_cart',
  );

  await assert.rejects(
    resolve(storeA.slug, [
      { productSlug: 'arroz-costeno', storeSlug: storeB.slug, quantity: 1 },
    ]),
    (error: unknown) => (error as { code?: string }).code === 'mixed_store_cart',
  );
});

test('checkout: producto no publicado y tienda inactiva se rechazan', async () => {
  const sql = platform.requirePlatformSql();
  await sql`
    UPDATE store_products SET visible = FALSE
     WHERE store_id = ${storeA.id}::uuid AND slug = 'arroz-costeno'
  `;
  await assert.rejects(
    resolve(storeA.slug, [{ productSlug: 'arroz-costeno', quantity: 1 }]),
    (error: unknown) => (error as { code?: string }).code === 'product_not_available',
  );
  await sql`
    UPDATE store_products SET visible = TRUE
     WHERE store_id = ${storeA.id}::uuid AND slug = 'arroz-costeno'
  `;

  await sql`UPDATE stores SET active = FALSE WHERE id = ${storeB.id}::uuid`;
  await assert.rejects(
    resolve(storeB.slug, [{ productSlug: 'tela-lino-rojo', quantity: 1 }]),
    (error: unknown) => (error as { code?: string }).code === 'store_inactive',
  );
  await sql`UPDATE stores SET active = TRUE WHERE id = ${storeB.id}::uuid`;
});

test('orders: reserva stock de la variante correcta y conserva snapshot', async () => {
  const resolved = await resolve(storeA.slug, [
    {
      productSlug: 'polo-algodon',
      quantity: 2,
      variant: { talla: 'M', color: 'negro' },
    },
  ]);

  const order = await commerce.createOrder(
    {
      idempotencyKey: `catalog-${randomUUID()}`,
      contactEmail: 'cliente@example.invalid',
      fulfillmentType: 'pickup_locker',
      storeId: resolved.store.id,
      items: resolved.lines,
    },
    { metadata: { test: 'multi-store-catalog' } },
  );
  ownOrderId = order.id;

  const sql = platform.requirePlatformSql();
  const items = await sql`
    SELECT product_name, variant_key, variant_sku, unit_price, quantity, line_total
      FROM order_items WHERE order_id = ${order.id}::uuid
  `;
  assert.equal(items.length, 1);
  assert.equal(String(items[0]?.product_name), 'Polo algodón');
  assert.equal(String(items[0]?.variant_key), 'color:negro|talla:m');
  assert.ok(String(items[0]?.variant_sku).length > 0);
  assert.equal(Number(items[0]?.unit_price), 43.9);
  assert.equal(Number(items[0]?.line_total), 87.8);

  const inventoryRows = await sql`
    SELECT variant_key, quantity_reserved
      FROM inventory
     WHERE store_id = ${storeA.id}::uuid AND product_slug = 'polo-algodon'
     ORDER BY variant_key
  `;
  const byVariant = new Map(
    inventoryRows.map((row) => [String(row.variant_key), Number(row.quantity_reserved)]),
  );
  assert.equal(byVariant.get('color:negro|talla:m'), 2);
  assert.equal(byVariant.get('color:blanco|talla:m') ?? 0, 0, 'la talla M blanca no se toca');
  assert.equal(byVariant.get('color:negro|talla:l') ?? 0, 0, 'la talla L negra no se toca');
});

test('orders: stock insuficiente devuelve 409 lógico y no crea pedido', async () => {
  const resolved = await resolve(storeA.slug, [
    {
      productSlug: 'polo-algodon',
      quantity: 99,
      variant: { talla: 'L', color: 'negro' },
    },
  ]);

  await assert.rejects(
    commerce.createOrder(
      {
        idempotencyKey: `catalog-short-${randomUUID()}`,
        contactEmail: 'cliente@example.invalid',
        fulfillmentType: 'pickup_locker',
        storeId: resolved.store.id,
        items: resolved.lines,
      },
      { metadata: { test: 'insufficient' } },
    ),
    (error: unknown) => /insufficient_stock/.test(String((error as Error).message)),
  );
});

test('history: archivar el producto no rompe el pedido anterior', async () => {
  await catalog.updateStoreProductCatalog(userA.id, storeA.id, productoVariantesAId, {
    archived: true,
    visible: false,
  });

  const sql = platform.requirePlatformSql();
  const items = await sql`
    SELECT product_name, variant_sku, unit_price, line_total
      FROM order_items WHERE order_id = ${ownOrderId}::uuid
  `;
  assert.equal(items.length, 1);
  assert.equal(String(items[0]?.product_name), 'Polo algodón');
  assert.equal(Number(items[0]?.line_total), 87.8);

  const stored = await commerce.getOrderByPublicToken(
    (
      await sql`SELECT public_token FROM orders WHERE id = ${ownOrderId}::uuid`
    )[0]?.public_token as string,
  );
  assert.ok(stored, 'el pedido histórico sigue siendo legible');
  assert.equal(stored?.items[0]?.productName, 'Polo algodón');
});

// =============================================================================
//  STORAGE
// =============================================================================

function imageFile(bytes: Uint8Array, name = 'imagen.png'): File {
  return new File([bytes as unknown as BlobPart], name, { type: 'image/png' });
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

test('storage: guarda una imagen válida con key del servidor y la sirve', async () => {
  const media = await storage.putImage({
    scope: 'product_image',
    file: imageFile(PNG_BYTES),
    userId: userA.id,
    storeId: storeA.id,
    storeProductId: (await catalog.createStoreProductCatalog(userA.id, storeA.id, {
      name: 'Producto con imagen',
      priceCents: 500,
    })).id as string,
  });

  assert.match(media.key, /^product_image\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
  assert.equal(media.mime, 'image/png');
  assert.ok(!media.key.includes('..'));

  const fetched = await storage.getMedia(media.key);
  assert.ok(fetched);
  assert.equal(fetched?.mime, 'image/png');
  assert.deepEqual(Array.from(fetched?.bytes ?? []), Array.from(PNG_BYTES));

  assert.equal(await storage.getMedia('../etc/passwd'), null);
  assert.equal(await storage.getMedia(media.key.replace('.png', '.jpg')), null);
});

test('storage: rechaza MIME falso y archivo demasiado grande', async () => {
  await assert.rejects(
    storage.putImage({
      scope: 'store_logo',
      file: imageFile(new TextEncoder().encode('no soy una imagen')),
      userId: userA.id,
      storeId: storeA.id,
    }),
    (error: unknown) => (error as { code?: string }).code === 'media_invalid_mime',
  );

  const tooLarge = new Uint8Array(storage.MAX_IMAGE_BYTES + 1);
  tooLarge.set(PNG_BYTES);
  await assert.rejects(
    storage.putImage({
      scope: 'store_logo',
      file: imageFile(tooLarge),
      userId: userA.id,
      storeId: storeA.id,
    }),
    (error: unknown) => (error as { code?: string }).code === 'media_too_large',
  );
});

test('storage: la autorización de subida es store-scoped', async () => {
  await assert.rejects(
    stores.requireStoreAccess(userB.id, storeA.id),
    (error: unknown) => (error as { code?: string }).code === 'store_forbidden',
  );
});

// =============================================================================
//  CONTEOS PARA PLANES
// =============================================================================

test('planes: cuenta SKU publicados sin bloquear todavía', async () => {
  const countA = await master.countPublishedSkusByStore(storeA.id);
  const countB = await master.countPublishedSkusByStore(storeB.id);
  assert.ok(countA >= 1, 'A conserva los SKU vendibles');
  assert.ok(countB >= 1, 'B cuenta su producto propio');
  assert.notEqual(countA, countB);
});
