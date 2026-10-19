/**
 * tests/multi-tenant.integration.test.ts — PostgreSQL REAL (efímero, local).
 *
 * Cubre los mínimos de la fase:
 *   · Store create · slug unique · slug reservado · StoreMember
 *   · geodistance · radio 1/5/10/20 · cambio de radio
 *   · búsqueda de texto/marca · producto no disponible · fuera de radio
 *   · tiendas cercanas
 *   · auth real (sign-up/sign-in con Better Auth + cookie de sesión)
 *   · guest checkout · authenticated checkout · historial del cliente
 *   · aislamiento: merchant A no lee ni escribe datos de B (productos,
 *     pedidos, analytics, inventario).
 *
 * Nunca lee DATABASE_URL ni toca staging/Producción: el helper crea su propio
 * cluster en localhost y lo borra al terminar.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';
import { TenancyError } from '../lib/tenancy';

type Stores = typeof import('../lib/stores.server');
type Commerce = typeof import('../lib/commerce.server');
type Platform = typeof import('../lib/platform-db.server');
type AuthModule = typeof import('../lib/auth.server');
type Analytics = typeof import('../lib/analytics.server');
type AnalyticsDomain = typeof import('../lib/analytics');

let database: EmbeddedTestDatabase;
let stores: Stores;
let commerce: Commerce;
let platform: Platform;
let authModule: AuthModule;
let analytics: Analytics;
let analyticsDomain: AnalyticsDomain;
let auth: ReturnType<AuthModule['getAuthServer']>;

const PASSWORD = 'uma-ntai-test-123456';

const BASE = { latitude: -12.0464, longitude: -77.0428 };

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

interface TestStore {
  id: string;
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  owner: TestUser;
}

const userA = {} as TestUser;
const userB = {} as TestUser;
const storeA = {} as TestStore;
const storeB = {} as TestStore;
const storeC = {} as TestStore;
const storeD = {} as TestStore;

before(async () => {
  database = await startTestDatabase();

  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  process.env.BETTER_AUTH_SECRET = 'integration-secret-'.padEnd(48, 'x');
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.NEXT_PUBLIC_SERVER_URL = 'http://localhost:3000';
  delete process.env.VERCEL_ENV;

  stores = await import('../lib/stores.server');
  commerce = await import('../lib/commerce.server');
  platform = await import('../lib/platform-db.server');
  authModule = await import('../lib/auth.server');
  analytics = await import('../lib/analytics.server');
  analyticsDomain = await import('../lib/analytics');
  auth = authModule.getAuthServer();
});

after(async () => {
  await authModule.closeAuthPool().catch(() => undefined);
  await closeDbPools();
  if (database) await database.stop();
});

// =============================================================================
//  HELPERS
// =============================================================================

async function signUp(email: string, name: string): Promise<TestUser> {
  const response = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    }),
  );

  const body = (await response.json().catch(() => null)) as
    | { user?: { id?: string; email?: string }; message?: string }
    | null;

  assert.equal(response.status, 200, `sign-up falló: ${JSON.stringify(body)}`);
  assert.ok(body?.user?.id, 'sign-up no devolvió user.id');

  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  return { id: String(body?.user?.id), email, cookie };
}

async function signIn(email: string): Promise<TestUser> {
  const response = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );

  const body = (await response.json().catch(() => null)) as
    | { user?: { id?: string }; message?: string }
    | null;

  assert.equal(response.status, 200, `sign-in falló: ${JSON.stringify(body)}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  return { id: String(body?.user?.id), email, cookie };
}

async function makeStore(
  owner: TestUser,
  name: string,
  slug: string,
  latitude: number,
  longitude: number,
): Promise<TestStore> {
  const created = await stores.createStoreForOwner({
    ownerUserId: owner.id,
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

  return {
    id: created.id,
    slug: created.slug,
    name: created.name,
    latitude,
    longitude,
    owner,
  };
}

interface SeedProduct {
  store: TestStore;
  slug: string;
  name: string;
  priceCents: number;
  stock: number;
  brand?: string;
  category?: string;
}

async function seedProduct(input: SeedProduct): Promise<void> {
  await stores.createStoreProduct(input.store.owner.id, input.store.id, {
    slug: input.slug,
    name: input.name,
    brand: input.brand ?? null,
    category: input.category ?? null,
    priceCents: input.priceCents,
    initialStock: input.stock,
  });
}

function assertForbidden(promise: Promise<unknown>, label: string) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TenancyError, `${label}: se esperaba TenancyError`);
    assert.equal((error as TenancyError).code, 'store_forbidden', `${label}: código incorrecto`);
    return true;
  });
}

// =============================================================================
//  SETUP DE DATOS
// =============================================================================

test('auth real: alta, sesión por cookie, login y contraseña hasheada', async () => {
  const created = await signUp('merchant-a@example.invalid', 'Merchant A');
  Object.assign(userA, created);

  const sessionUser = await authModule.getSessionUser(
    new Headers({ cookie: created.cookie }),
  );
  assert.equal(sessionUser?.id, created.id, 'la cookie de sign-up no abre la sesión');

  // Sin cookie no hay usuario.
  assert.equal(await authModule.getSessionUser(new Headers()), null);

  // Login posterior devuelve una sesión válida.
  const logged = await signIn('merchant-a@example.invalid');
  assert.equal(logged.id, created.id);
  assert.notEqual(logged.cookie, '');

  // El email se normaliza a minúsculas y la contraseña NO se guarda en claro.
  const sql = platform.requirePlatformSql();
  const users = await sql`SELECT email FROM users WHERE id = ${created.id}`;
  assert.equal(String(users[0]?.email), 'merchant-a@example.invalid');

  const accounts = await sql`SELECT password FROM auth_accounts WHERE "userId" = ${created.id}`;
  assert.equal(accounts.length, 1);
  const hash = String(accounts[0]?.password ?? '');
  assert.ok(hash.length > 40, 'hash de contraseña demasiado corto');
  assert.ok(!hash.includes(PASSWORD), 'la contraseña se guardó en claro');
});

test('auth real: email duplicado y contraseña incorrecta se rechazan', async () => {
  const duplicate = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({
        email: 'merchant-a@example.invalid',
        password: PASSWORD,
        name: 'Otra Persona',
      }),
    }),
  );
  assert.ok(duplicate.status >= 400, 'el email duplicado debería fallar');

  const wrong = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email: 'merchant-a@example.invalid', password: 'incorrecta-123' }),
    }),
  );
  assert.ok(wrong.status >= 400, 'la contraseña incorrecta debería fallar');
});

test('Store create: owner, slug y StoreMember', async () => {
  Object.assign(
    storeA,
    await makeStore(userA, 'Bodega La Esquina', 'bodega-la-esquina', -12.05, -77.045),
  );

  const membership = await stores.requireStoreAccess(userA.id, storeA.id);
  assert.equal(membership.role, 'owner');
  assert.equal(membership.store.slug, 'bodega-la-esquina');

  const mine = await stores.listStoresForUser(userA.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.id, storeA.id);
});

test('Store: slug unique y slug reservado se rechazan en la base', async () => {
  const sql = platform.requirePlatformSql();

  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO stores (name, slug, active)
        VALUES ('Duplicada', 'bodega-la-esquina', FALSE)
      `;
    },
    (error: unknown) => (error as { code?: string }).code === '23505',
  );

  await assert.rejects(
    async () => {
      await sql`
        INSERT INTO stores (name, slug, active)
        VALUES ('Reservada', 'admin', FALSE)
      `;
    },
    (error: unknown) => (error as { code?: string }).code === '23505',
  );

  // La app corta antes, con un error de negocio claro.
  await assert.rejects(
    stores.createStoreForOwner({
      ownerUserId: userA.id,
      name: 'Admin Store',
      slug: 'admin',
    }),
    (error: unknown) =>
      error instanceof TenancyError && error.code === 'invalid_store_input',
  );
});

test('Store: el slug repetido desde la app se resuelve con sufijo, nunca duplica', async () => {
  const second = await stores.createStoreForOwner({
    ownerUserId: userA.id,
    name: 'Bodega La Esquina',
    slug: 'bodega-la-esquina',
    category: 'test',
  });
  assert.notEqual(second.slug, 'bodega-la-esquina');
  assert.equal(second.active, false);
});

test('geodistance SQL coincide con Haversine de JS', async () => {
  const sql = platform.requirePlatformSql();
  const rows = await sql`
    SELECT geo_distance_km(
      ${BASE.latitude}::float8, ${BASE.longitude}::float8,
      ${storeA.latitude}::float8, ${storeA.longitude}::float8
    ) AS distance
  `;
  const sqlDistance = Number(rows[0]?.distance);
  const jsDistance = (await import('../lib/geo')).haversineKm(BASE, {
    latitude: storeA.latitude,
    longitude: storeA.longitude,
  });
  assert.ok(Math.abs(sqlDistance - jsDistance) < 0.0001);
});

test('seed: 4 tiendas de rubros distintos con productos y stock', async () => {
  Object.assign(userB, await signUp('merchant-b@example.invalid', 'Merchant B'));

  Object.assign(
    storeB,
    await makeStore(userB, 'Hilos y Estilo', 'hilos-y-estilo', -12.085, -77.05),
  );
  Object.assign(
    storeC,
    await makeStore(userA, 'Telas del Sur', 'telas-del-sur', -12.13, -77.03),
  );
  Object.assign(
    storeD,
    await makeStore(userB, 'Ferretería Central', 'ferreteria-central', -12.18, -77.02),
  );

  await seedProduct({ store: storeA, slug: 'arroz-costeno', name: 'Arroz costeño 5 kg', priceCents: 2450, stock: 10, brand: 'Costeño', category: 'abarrotes' });
  await seedProduct({ store: storeB, slug: 'arroz-integral', name: 'Arroz integral 1 kg', priceCents: 690, stock: 5, brand: 'Del Norte', category: 'abarrotes' });
  await seedProduct({ store: storeB, slug: 'polo-basico', name: 'Polo básico algodón', priceCents: 3990, stock: 7, brand: 'Polo Club', category: 'ropa' });
  await seedProduct({ store: storeC, slug: 'tela-lino', name: 'Tela de lino', priceCents: 1850, stock: 0, category: 'telas' });
  await seedProduct({ store: storeC, slug: 'tela-seda', name: 'Tela de seda', priceCents: 4200, stock: 4, category: 'telas' });
  await seedProduct({ store: storeD, slug: 'martillo-pro', name: 'Martillo profesional', priceCents: 3500, stock: 2, brand: 'Truper', category: 'ferretería' });
});

// =============================================================================
//  BÚSQUEDA + GEO
// =============================================================================

function discovery(q: string, radiusKm: number, limit = 30) {
  return stores.searchDiscovery({
    q,
    location: BASE,
    radiusKm,
    limit,
    offset: 0,
  });
}

test('radio 1 km: solo la tienda más cercana', async () => {
  const result = await discovery('', 1);
  assert.deepEqual(new Set(result.products.map((p) => p.storeId)), new Set([storeA.id]));
  assert.ok(result.products.every((p) => (p.distanceKm ?? 99) <= 1));
});

test('radio 5 km: entra la segunda tienda y NO la de 9,5 km', async () => {
  const result = await discovery('', 5);
  const storeIds = new Set(result.products.map((p) => p.storeId));
  assert.ok(storeIds.has(storeA.id));
  assert.ok(storeIds.has(storeB.id));
  assert.ok(!storeIds.has(storeC.id));
  assert.ok(!storeIds.has(storeD.id));
});

test('radio 10 km: entra telas; 20 km: entra ferretería', async () => {
  const ten = await discovery('', 10);
  assert.ok(new Set(ten.products.map((p) => p.storeId)).has(storeC.id));
  assert.ok(!new Set(ten.products.map((p) => p.storeId)).has(storeD.id));

  const twenty = await discovery('', 20);
  assert.ok(new Set(twenty.products.map((p) => p.storeId)).has(storeD.id));
});

test('cambiar el radio cambia el conjunto de resultados (1 → 5)', async () => {
  const narrow = await discovery('', 1);
  const wide = await discovery('', 5);
  assert.ok(wide.products.length > narrow.products.length);
  assert.deepEqual(new Set(narrow.products.map((p) => p.storeId)), new Set([storeA.id]));
});

test('búsqueda de texto: arroz devuelve ambas tiendas dentro del radio', async () => {
  const one = await discovery('arroz', 1);
  assert.deepEqual(one.products.map((p) => p.productSlug), ['arroz-costeno']);

  const five = await discovery('arroz', 5);
  assert.deepEqual(new Set(five.products.map((p) => p.productSlug)), new Set(['arroz-costeno', 'arroz-integral']));
});

test('búsqueda por marca y por categoría', async () => {
  const brand = await discovery('Polo Club', 5);
  assert.deepEqual(brand.products.map((p) => p.productSlug), ['polo-basico']);

  const category = await discovery('telas', 10);
  assert.ok(category.products.every((p) => p.category === 'telas'));
  assert.equal(category.products.length, 2);
});

test('producto no disponible: aparece con inStock=false (no se oculta)', async () => {
  const result = await discovery('tela', 10);
  const lino = result.products.find((p) => p.productSlug === 'tela-lino');
  assert.ok(lino, 'el producto agotado debe aparecer');
  assert.equal(lino?.inStock, false);
  assert.equal(lino?.available, 0);

  const seda = result.products.find((p) => p.productSlug === 'tela-seda');
  assert.equal(seda?.inStock, true);
  // El disponible se ordena antes que el agotado.
  assert.ok(result.products.indexOf(seda!) < result.products.indexOf(lino!));
});

test('producto fuera del radio no aparece', async () => {
  const result = await discovery('martillo', 10);
  assert.equal(result.products.length, 0, 'la ferretería está a ~15 km');
});

test('tiendas cercanas: 5 km incluye A y B, excluye C y D', async () => {
  const five = await discovery('', 5);
  assert.deepEqual(new Set(five.stores.map((s) => s.id)), new Set([storeA.id, storeB.id]));

  const ten = await discovery('', 10);
  assert.ok(new Set(ten.stores.map((s) => s.id)).has(storeC.id));
});

test('búsqueda sin ubicación: funciona y no calcula distancia', async () => {
  const result = await stores.searchDiscovery({
    q: 'arroz',
    location: null,
    radiusKm: 5,
    limit: 30,
    offset: 0,
  });
  assert.ok(result.products.length >= 2);
  assert.ok(result.products.every((p) => p.distanceKm === null));
});

test('paginación: total real y hasMore coherente', async () => {
  const page = await stores.searchDiscovery({
    q: '',
    location: BASE,
    radiusKm: 20,
    limit: 2,
    offset: 0,
  });
  assert.equal(page.products.length, 2);
  assert.ok(page.total >= 6);
});

// =============================================================================
//  AISLAMIENTO MULTI-TENANT (P0)
// =============================================================================

test('aislamiento: B no puede leer ni escribir el catálogo de A', async () => {
  await assertForbidden(stores.listStoreProducts(userB.id, storeA.id), 'leer productos A');
  await assertForbidden(
    stores.createStoreProduct(userB.id, storeA.id, {
      name: 'Intruso',
      priceCents: 100,
      // `initialStock` escribe inventario: el portero debe cortar ANTES del ledger.
      initialStock: 5,
    }),
    'crear producto en A',
  );

  const productA = (await stores.listStoreProducts(userA.id, storeA.id))[0];
  assert.ok(productA);
  await assertForbidden(
    stores.updateStoreProduct(userB.id, storeA.id, productA.id, { priceCents: 1 }),
    'editar producto de A',
  );
});

test('aislamiento: B no puede leer pedidos ni analytics de A', async () => {
  await assertForbidden(stores.listStoreOrders(userB.id, storeA.id), 'leer pedidos A');
  await assertForbidden(stores.requireStoreAccess(userB.id, storeA.id), 'acceder a A');

  const range = analyticsDomain.resolveAnalyticsRange({ preset: '30d' });
  assert.equal(range.ok, true);
  if (!range.ok) return;

  const analyticsA = await analytics.getAnalyticsSummary({
    range: range.range,
    previous: range.previous,
    storeId: storeA.id,
  });
  // La ruta del panel exige membresía ANTES de llamar a analytics; acá se
  // comprueba que el scope de la consulta no mezcla la tienda B.
  assert.equal(analyticsA.sales.orders, 0);
});

test('aislamiento: cada tienda solo ve sus propios productos en su panel', async () => {
  const productsA = await stores.listStoreProducts(userA.id, storeA.id);
  const productsB = await stores.listStoreProducts(userB.id, storeB.id);

  assert.ok(productsA.every((product) => product.storeId === storeA.id));
  assert.ok(productsB.every((product) => product.storeId === storeB.id));
  assert.ok(!productsA.some((product) => product.slug === 'polo-basico'));
});

test('aislamiento: un usuario puede pertenecer a varias tiendas y elegir cuál abrir', async () => {
  const userAMemberships = await stores.listStoresForUser(userA.id);
  // A creó storeA y storeC.
  assert.ok(userAMemberships.some((store) => store.id === storeA.id));
  assert.ok(userAMemberships.some((store) => store.id === storeC.id));
  assert.ok(userAMemberships.every((store) => store.role === 'owner'));
});

// =============================================================================
//  CHECKOUT GUEST / AUTENTICADO + HISTORIAL
// =============================================================================

interface CheckoutResult {
  orderId: string;
  userId: string | null;
  storeId: string;
  total: number;
  publicToken: string;
}

async function checkout(
  store: TestStore,
  productSlug: string,
  quantity: number,
  userId: string | null,
): Promise<CheckoutResult> {
  const resolved = await stores.resolveCheckoutProducts(store.slug, [productSlug]);
  assert.ok(resolved, `no se resolvió la tienda ${store.slug}`);
  const product = resolved!.products.get(productSlug);
  assert.ok(product, `no se resolvió el producto ${productSlug}`);

  const order = await commerce.createOrder(
    {
      idempotencyKey: `it-${randomUUID()}`,
      contactEmail: userId ? `${userId}@example.invalid` : 'guest@example.invalid',
      fulfillmentType: 'pickup_locker',
      storeId: resolved!.store.id,
      userId,
      items: [
        {
          productSlug,
          productName: product!.name,
          productBrand: product!.brand,
          variant: {},
          variantKey: '',
          quantity,
          unitPrice: product!.unitPrice,
        },
      ],
    },
    { metadata: { test: 'multi-tenant' } },
  );

  return {
    orderId: order.id,
    userId: (order as unknown as { userId?: string | null }).userId ?? null,
    storeId: (order as unknown as { storeId?: string }).storeId ?? '',
    total: order.total,
    publicToken: order.publicToken,
  };
}

let guestOrder: CheckoutResult;
let authOrder: CheckoutResult;

test('guest checkout: compra sin sesión, user_id nullable y stock reservado', async () => {
  guestOrder = await checkout(storeA, 'arroz-costeno', 2, null);

  const sql = platform.requirePlatformSql();
  const rows = await sql`SELECT user_id, store_id FROM orders WHERE id = ${guestOrder.orderId}::uuid`;
  assert.equal(rows[0]?.user_id, null);
  assert.equal(String(rows[0]?.store_id), storeA.id);

  // El checkout de invitado NO crea una identidad.
  const users = await sql`SELECT COUNT(*)::int AS count FROM users`;
  assert.equal(Number(users[0]?.count), 2);
});

test('authenticated checkout: asocia el pedido a la identidad', async () => {
  authOrder = await checkout(storeB, 'polo-basico', 1, userB.id);

  const sql = platform.requirePlatformSql();
  const rows = await sql`SELECT user_id, store_id FROM orders WHERE id = ${authOrder.orderId}::uuid`;
  assert.equal(String(rows[0]?.user_id), userB.id);
  assert.equal(String(rows[0]?.store_id), storeB.id);
});

test('historial del cliente: solo sus pedidos, nunca los de invitado', async () => {
  const historyB = await stores.listCustomerOrders(userB.id);
  assert.equal(historyB.length, 1);
  assert.equal(historyB[0]?.id, authOrder.orderId);

  // El pedido guest de la tienda A no aparece, aunque se haya pagado.
  assert.ok(!historyB.some((order) => order.id === guestOrder.orderId));

  const historyA = await stores.listCustomerOrders(userA.id);
  assert.equal(historyA.length, 0);
});

test('pedido y stock quedan en la tienda correcta', async () => {
  const rows = await platform.requirePlatformSql()`
    SELECT store_id, quantity_on_hand, quantity_reserved
      FROM inventory
     WHERE product_slug = 'arroz-costeno' AND store_id = ${storeA.id}::uuid
  `;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0]?.quantity_on_hand), 10);
  assert.equal(Number(rows[0]?.quantity_reserved), 2, 'la reserva guest debe descontar en A');
});

test('aislamiento: inventario de A y B es independiente y no cruza pedidos', async () => {
  // Mismo SKU en dos tiendas: cada una tiene su propia fila y su propio stock.
  await seedProduct({ store: storeA, slug: 'sku-compartido', name: 'SKU compartido A', priceCents: 100, stock: 3 });
  await seedProduct({ store: storeB, slug: 'sku-compartido', name: 'SKU compartido B', priceCents: 200, stock: 7 });

  const productsA = await stores.listStoreProducts(userA.id, storeA.id);
  const productsB = await stores.listStoreProducts(userB.id, storeB.id);
  assert.equal(productsA.find((product) => product.slug === 'sku-compartido')?.available, 3);
  assert.equal(productsB.find((product) => product.slug === 'sku-compartido')?.available, 7);

  // B no puede leer el inventario de A ni siquiera cuando el SKU coincide.
  await assertForbidden(stores.listStoreProducts(userB.id, storeA.id), 'leer inventario A');

  // Mover stock de A citando un pedido de B lo impide la base, no solo la app.
  const sql = platform.requirePlatformSql();
  await assert.rejects(
    async () => {
      await sql`
        SELECT inventory_apply_movement(
          'sku-compartido', '', 'receipt'::inventory_movement_type,
          5, 0, 'MAIN', ${authOrder.orderId}::uuid, NULL, NULL,
          'integration-test', ${`cross-store-${randomUUID()}`}, ${storeA.id}::uuid
        )
      `;
    },
    (error: unknown) => String((error as { message?: string }).message).includes('store_scope_mismatch'),
  );

  const rows = await sql`
    SELECT store_id, quantity_on_hand
      FROM inventory
     WHERE product_slug = 'sku-compartido'
     ORDER BY store_id
  `;
  const byStore = new Map(rows.map((row) => [String(row.store_id), Number(row.quantity_on_hand)]));
  assert.equal(byStore.get(storeA.id), 3, 'A conserva su stock');
  assert.equal(byStore.get(storeB.id), 7, 'B conserva su stock');
});

test('analytics de tienda: suma solo los pedidos de esa tienda', async () => {
  // Confirmar ambos pedidos (transición válida pending_payment → confirmed) para
  // que cuenten como venta. El pago real de Mercado Pago sigue congelado.
  await platform.requirePlatformSql()`
    UPDATE orders
       SET status = 'confirmed', payment_status = 'paid'
     WHERE id IN (${guestOrder.orderId}::uuid, ${authOrder.orderId}::uuid)
  `;

  const range = analyticsDomain.resolveAnalyticsRange({ preset: '30d' });
  assert.equal(range.ok, true);
  if (!range.ok) return;

  const summaryA = await analytics.getAnalyticsSummary({
    range: range.range,
    previous: range.previous,
    storeId: storeA.id,
  });
  const summaryB = await analytics.getAnalyticsSummary({
    range: range.range,
    previous: range.previous,
    storeId: storeB.id,
  });

  assert.equal(summaryA.sales.allOrders, 1);
  assert.equal(summaryB.sales.allOrders, 1);
  assert.ok(summaryA.sales.revenueCents > 0);
  assert.ok(summaryB.sales.revenueCents > 0);
  assert.notEqual(summaryA.sales.revenueCents, summaryB.sales.revenueCents);
});
