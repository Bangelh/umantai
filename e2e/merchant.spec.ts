import { expect, test } from '@playwright/test';

import { createStoreViaApi, loginUi, signUpUi, uniqueEmail, uniqueSlug } from './helpers';

/**
 * Merchant: alta de tienda, catálogo propio y aislamiento entre tiendas.
 * La tienda se crea INACTIVA (comportamiento real); el catálogo se prepara
 * igual. No se activa ni se toca Mercado Pago.
 */

test.describe.serial('merchant', () => {
  const email = uniqueEmail('e2e-merchant');
  const storeName = `E2E Bodega ${Date.now()}`;
  const slug = uniqueSlug('e2e-store');
  let storeId = '';

  test('alta de tienda desde /vender', async ({ page }) => {
    await signUpUi(page, email, 'E2E Merchant');
    await page.goto('/vender');
    await page.getByLabel(/Nombre del negocio/).fill(storeName);
    await page.getByLabel(/Rubro/).fill('abarrotes');
    await page.getByLabel(/Teléfono/).fill('999888777');
    await page.getByLabel(/Dirección del local/).fill('Av. E2E 123');
    await page.getByLabel(/Zona/).selectOption({ index: 1 });
    await page.getByRole('button', { name: /Crear mi tienda/ }).click();
    await expect(page.getByRole('heading', { name: 'Tienda creada' })).toBeVisible();
    await expect(page.getByText(/pendiente de aprobación/)).toBeVisible();

    const link = page.getByRole('link', { name: /Ir al panel/ });
    const href = await link.getAttribute('href');
    storeId = (href ?? '').split('/').pop() ?? '';
    expect(storeId).toMatch(/[0-9a-f-]{36}/);
  });

  test('catálogo: crear producto propio y verlo en el panel', async ({ page }) => {
    // Contexto nuevo por test: se vuelve a entrar con la misma cuenta.
    await loginUi(page, email);
    await page.goto(`/negocio/${storeId}`);
    await page.getByRole('button', { name: '+ Producto propio' }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('Producto E2E');
    await page.getByLabel(/Precio \(S\/\)/).fill('12.50');
    await page.getByLabel(/Stock inicial/).fill('7');
    await page.getByRole('button', { name: /Guardar y publicar/ }).click();
    await expect(page.getByText('Producto E2E').first()).toBeVisible({ timeout: 20_000 });
  });

  test('inventario, analytics y planes están en el panel del comerciante', async ({ page }) => {
    await loginUi(page, email);
    await page.goto(`/negocio/${storeId}`);
    await expect(page.getByText(/Ventas 30d/)).toBeVisible();
    await expect(page.getByText(/Ticket medio/)).toBeVisible();
    await expect(page.getByText('Plan y facturación')).toBeVisible();
  });

  test('tenant isolation UI: otra cuenta no accede al panel de esta tienda', async ({ page }) => {
    const otherEmail = uniqueEmail('e2e-other');
    const context = await page.context().browser()?.newContext();
    expect(context).toBeTruthy();
    const other = await context!.newPage();
    try {
      await signUpUi(other, otherEmail, 'E2E Other');
      const response = await other.goto(`/negocio/${storeId}`);
      expect(response?.status()).toBe(404);
      await expect(other.getByRole('heading', { level: 1 })).not.toContainText(storeName);
    } finally {
      await context!.close();
    }
  });

  test('un usuario no puede consultar por API una tienda ajena', async ({ page }) => {
    const otherEmail = uniqueEmail('e2e-api-other');
    const context = await page.context().browser()?.newContext();
    const other = await context!.newPage();
    try {
      await signUpUi(other, otherEmail, 'E2E API Other');
      const response = await other.request.get(`/api/merchant/stores/${storeId}/products`);
      expect([403, 404]).toContain(response.status());
    } finally {
      await context!.close();
    }
  });

  test('la tienda inactiva no aparece en el buscador', async ({ request }) => {
    const response = await request.get(`/api/search?q=${encodeURIComponent('Producto E2E')}`);
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as { stores: Array<{ id: string }> };
    expect(payload.stores.some((store) => store.id === storeId)).toBe(false);
  });

  test('slug duplicado se resuelve con un sufijo en vez de fallar', async ({ page }) => {
    await signUpUi(page, uniqueEmail('e2e-dup'), 'E2E Dup');
    const first = await createStoreViaApi(page, 'Duplicada', slug);
    expect(first.slug).toBe(slug);

    const response = await page.request.post('/api/merchant/stores', {
      data: { name: 'Duplicada', slug },
    });
    // El alta reintenta con `-2`, `-3`… antes de rendirse (createStoreForOwner).
    expect(response.status()).toBe(201);
    const payload = (await response.json()) as { store: { slug: string } };
    expect(payload.store.slug).toMatch(new RegExp(`^${slug}-\\d+$`));
  });

  test('crear tienda por API funciona para el flujo automatizado', async ({ page }) => {
    await signUpUi(page, uniqueEmail('e2e-api-store'), 'E2E API Store');
    const store = await createStoreViaApi(page, 'E2E API Store', uniqueSlug('e2e-api'));
    expect(store.id).toMatch(/[0-9a-f-]{36}/);
  });
});
