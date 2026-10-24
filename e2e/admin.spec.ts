import { expect, test } from '@playwright/test';

import { E2E_PASSWORD, signUpUi, uniqueEmail } from './helpers';

/**
 * Platform Admin sin token manual.
 *
 * · La UI nunca muestra un campo `ADMIN_API_SECRET`.
 * · Un usuario normal no puede activar la sesión (403 explicado).
 * · Con `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` (cuenta ya autorizada en
 *   `platform_admins`), se recorren inventario, analytics y planes.
 */

test('la bandeja de reclamaciones exige sesión de Platform Admin', async ({ request }) => {
  const response = await request.get('/api/admin/complaints');
  expect(response.status()).toBe(401);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe('admin_session_required');
});

test('el panel legacy no pide token y ofrece la sesión de cuenta', async ({ page }) => {
  const response = await page.goto('/admin');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Platform Admin').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Activar sesión de administrador/ })).toBeVisible();
  await expect(page.getByPlaceholder(/ADMIN_API_SECRET|token/i)).toHaveCount(0);
});

test('todas las rutas /admin usan la misma puerta de sesión', async ({ page }) => {
  for (const path of [
    '/admin/inventario',
    '/admin/analytics',
    '/admin/planes',
    '/admin/catalogo',
    '/admin/reclamaciones',
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.getByText('Platform Admin').first()).toBeVisible();
    await expect(page.getByPlaceholder(/ADMIN_API_SECRET|token/i)).toHaveCount(0);
  }
});

test('un usuario sin rol recibe un 403 explicado', async ({ page }) => {
  await signUpUi(page, uniqueEmail('e2e-noadmin'), 'E2E No Admin');
  await page.goto('/admin/planes');
  await page.getByRole('button', { name: /Activar sesión de administrador/ }).click();
  await expect(page.getByText(/no tiene permisos de Platform Admin|no es Platform Admin/i)).toBeVisible();
});

test.describe('Platform Admin autorizado', () => {
  const email = process.env.E2E_ADMIN_EMAIL ?? '';
  const password = process.env.E2E_ADMIN_PASSWORD ?? E2E_PASSWORD;

  test.skip(!email, 'define E2E_ADMIN_EMAIL para probar el panel autorizado');

  test.beforeEach(async ({ page }) => {
    await page.goto('/ingresar');
    await page.getByLabel('Correo', { exact: true }).fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: /^Ingresar$/ }).click();
    await page.waitForURL(/\/cuenta/, { timeout: 20_000 });
  });

  test('activa sesión y abre planes, inventario y analytics', async ({ page }) => {
    await page.goto('/admin/planes');
    await page.getByRole('button', { name: /Activar sesión de administrador/ }).click();
    await expect(page.getByText(/Sesión de administrador:/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /Planes y suscripciones/ })).toBeVisible();

    for (const path of ['/admin/inventario', '/admin/analytics', '/admin/reclamaciones']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });
});
