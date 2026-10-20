import { expect, test } from '@playwright/test';

/**
 * E2E públicos contra staging. No requieren credenciales.
 * Cubren el artefacto desplegado: tema, idioma, tienda, headers y CSRF.
 */

test('home responde 200 con headers de seguridad y CSP', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  const headers = response?.headers() ?? {};
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['strict-transport-security']).toContain('max-age=');

  await expect(page.locator('html')).toHaveAttribute('lang', /^(es|en)$/);
});

test('tema claro se aplica y persiste tras recargar', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.removeItem('umantai_theme'));
  await page.reload();

  const toggle = page.getByRole('button', { name: /Tema|Theme/ }).first();
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('cambiar a inglés traduce la interfaz y persiste', async ({ page }) => {
  await page.goto('/');
  const select = page.locator('select[aria-label="Idioma"], select[aria-label="Language"]').first();
  await expect(select).toBeVisible();
  await select.selectOption('en');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();

  // Restaura español para no dejar la cookie del navegador de test en inglés.
  const englishSelect = page.locator('select[aria-label="Language"]').first();
  await englishSelect.selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});

test('vitrina pública de una tienda sembrada carga', async ({ page }) => {
  const response = await page.goto('/hilos-y-estilo');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hilos');
});

test('una mutación con Origin ajeno se rechaza (CSRF)', async ({ request }) => {
  const response = await request.post('/api/admin/session', {
    headers: { origin: 'https://evil.example' },
  });
  expect(response.status()).toBe(403);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe('csrf_origin_rejected');
});

test('/admin/planes pide sesión de Platform Admin sin romper', async ({ page }) => {
  const response = await page.goto('/admin/planes');
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/Platform Admin de UMANTAI/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Activar sesión de administrador/ }),
  ).toBeVisible();
});
