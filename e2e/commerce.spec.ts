import { expect, test, type APIRequestContext } from '@playwright/test';

import { signUpUi, uniqueEmail } from './helpers';

interface DiscoveryProduct {
  name: string;
  productSlug: string;
  storeSlug: string;
  storeId: string;
  storeName?: string;
}

async function discoverProducts(request: APIRequestContext): Promise<DiscoveryProduct[]> {
  const response = await request.get('/api/search?limit=50');
  if (!response.ok()) return [];
  const payload = (await response.json()) as { products?: DiscoveryProduct[] };
  return payload.products ?? [];
}

async function addFirstProductToCart(page: import('@playwright/test').Page, href: string) {
  await page.goto(href);
  const selects = page.locator('section select');
  for (let index = 0; index < (await selects.count()); index += 1) {
    const select = selects.nth(index);
    const options = await select.locator('option').all();
    if (options.length > 1) await select.selectOption({ index: 1 });
  }
  await page.getByRole('button', { name: /Agregar al carrito|No disponible/ }).click();
}

test.describe('home y búsqueda', () => {
  test('el buscador global devuelve resultados o un estado vacío claro', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('search');
    await expect(search).toBeVisible();
    await search.getByRole('textbox').fill('arroz');
    await search.getByRole('button', { name: /^Buscar$/ }).click();

    const results = page.getByRole('region', { name: /Resultados/i });
    await expect(results).toBeVisible();
    await expect(
      results.getByText(/No encontramos|No hay productos|Producto|Agotado|Disponible/).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('ubicación manual y radio actualizan el contexto de búsqueda', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Elegir zona manualmente/ }).click();
    const zone = page.getByLabel('Zona');
    await zone.selectOption({ index: 1 });
    await page.getByRole('button', { name: /Usar zona/ }).click();
    await expect(page.getByText(/Cerca de/)).toBeVisible();

    const radius = page.getByRole('group', { name: /Ubicación y radio|Radio de búsqueda/i });
    await radius.getByRole('button', { name: '10 km' }).click();
    await expect(radius.getByRole('button', { name: '10 km' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('coordenadas inválidas muestran error de validación', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Elegir zona manualmente/ }).click();
    await page.getByText(/O escribir coordenadas/).click();
    await page.getByLabel('Latitud').fill('999');
    await page.getByLabel('Longitud').fill('-77');
    await page.getByRole('button', { name: /^Aplicar$/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Coordenadas inválidas/ })).toBeVisible();
  });
});

test.describe.serial('carrito y checkout', () => {
  let products: DiscoveryProduct[] = [];

  test.beforeAll(async ({ request }) => {
    products = await discoverProducts(request);
  });

  test('agregar al carrito y revisar el pedido', async ({ page }) => {
    test.skip(products.length === 0, 'staging sin productos publicados');
    const product = products[0];
    await addFirstProductToCart(page, `/${product.storeSlug}/p/${product.productSlug}`);
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: /Tu carrito/i })).toBeVisible();
    await expect(page.getByText(product.name).first()).toBeVisible();
  });

  test('checkout de invitado crea el pedido sin Mercado Pago', async ({ page }) => {
    test.skip(products.length === 0, 'staging sin productos publicados');
    const product = products[1] ?? products[0];
    await addFirstProductToCart(page, `/${product.storeSlug}/p/${product.productSlug}`);
    await page.goto('/cart');
    await page.getByLabel(/Correo/).fill(uniqueEmail('e2e-guest'));
    await page.getByRole('button', { name: /Revisar pedido/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /Confirmar compra/ }).click();
    await page.waitForURL(/\/pedido\//, { timeout: 30_000 });
    await expect(page.getByText(/UM-\d{4}-\d+/).first()).toBeVisible();

    // Mercado Pago está congelado: el pedido se crea igual, pero no se ofrece cobro
    // online. Cuando se reabra el cobro hay que actualizar este test junto con el flag.
    await expect(page.getByText(/pago online no está disponible/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Pagar .* con Mercado Pago/i })).toHaveCount(0);
  });

  test('checkout autenticado usa la cuenta y conserva el pedido', async ({ page }) => {
    test.skip(products.length === 0, 'staging sin productos publicados');
    const email = uniqueEmail('e2e-buyer');
    await signUpUi(page, email, 'E2E Buyer');
    const product = products[2] ?? products[0];
    await addFirstProductToCart(page, `/${product.storeSlug}/p/${product.productSlug}`);
    await page.goto('/cart');
    await page.getByLabel(/Correo/).fill(email);
    await page.getByRole('button', { name: /Revisar pedido/ }).click();
    await page.getByRole('button', { name: /Confirmar compra/ }).click();
    await page.waitForURL(/\/pedido\//, { timeout: 30_000 });

    await page.goto('/cuenta');
    await expect(page.getByText(/UM-\d{4}-\d+/).first()).toBeVisible();
  });

  test('carrito multitienda exige comprar una tienda a la vez', async ({ page }) => {
    const byStore = new Map<string, DiscoveryProduct>();
    for (const product of products) {
      if (!byStore.has(product.storeId)) byStore.set(product.storeId, product);
    }
    test.skip(byStore.size < 2, 'staging necesita productos de dos tiendas');
    const [first, second] = [...byStore.values()];

    await addFirstProductToCart(page, `/${first.storeSlug}/p/${first.productSlug}`);
    await addFirstProductToCart(page, `/${second.storeSlug}/p/${second.productSlug}`);

    const dialog = page.getByRole('dialog', { name: /otra tienda/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Cambiar de tienda/ }).click();
    await page.goto('/cart');
    await expect(page.getByText(`Tienda: ${second.storeName ?? second.storeSlug}`)).toBeVisible();
  });
});
