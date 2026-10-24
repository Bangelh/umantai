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
  // CSP por request: script-src con nonce y sin unsafe-inline.
  const scriptSrc = (headers['content-security-policy'] ?? '')
    .split(';')
    .find((part) => part.trim().startsWith('script-src'));
  expect(scriptSrc).toContain('nonce-');
  expect(scriptSrc).not.toContain('unsafe-inline');
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

test('contacto muestra el correo y el WhatsApp configurados (sin duplicar datos)', async ({ page }) => {
  const response = await page.goto('/contacto');
  expect(response?.status()).toBe(200);

  await expect(page.locator('a[href="mailto:juancallerosales19@gmail.com"]')).toBeVisible();
  // Perú: el enlace lleva el código de país, aunque el negocio dicte 979363149.
  const whatsapp = page.getByRole('link', { name: '+51979363149' });
  await expect(whatsapp).toBeVisible();
  await expect(whatsapp).toHaveAttribute('href', /^https:\/\/wa\.me\/51979363149/);
});

test('legales: reembolsos prudente y aviso de documento no definitivo', async ({ page }) => {
  await page.goto('/legal/reembolsos');
  await expect(
    page.getByText(/no ofrece reembolsos voluntarios generales, sin perjuicio de los derechos/i),
  ).toBeVisible();
  await expect(page.getByText(/no renuncia|renuncia, limitación o exclusión/i).first()).toBeVisible();

  await page.goto('/legal');
  await expect(page.getByText(/no son definitivos para lanzamiento público/i)).toBeVisible();
  await expect(page.getByText(/razón social/i).first()).toBeVisible();
});

test('libro de reclamaciones: valida, registra y muestra constancia imprimible', async ({ page }) => {
  await page.goto('/libro-de-reclamaciones');
  await expect(page.getByRole('heading', { level: 1, name: /Libro de Reclamaciones/ })).toBeVisible();

  // Sin datos, el servidor responde con errores por campo y no crea nada.
  await page.getByRole('button', { name: /Registrar reclamo/ }).click();
  await expect(page.getByText(/Revisa los campos marcados/)).toBeVisible();
  await expect(page.getByText(/Este campo es obligatorio/).first()).toBeVisible();

  const marker = `E2E QA ${Date.now()}`;
  await page.locator('#complaint-name').fill('E2E Playwright QA');
  await page.locator('#complaint-document').fill('99999999');
  await page.locator('#complaint-phone').fill('+51 900 000 000');
  await page.locator('#complaint-email').fill('e2e-complaints@example.invalid');
  await page.locator('#complaint-item').fill(marker);
  await page.locator('#complaint-amount').fill('12.50');
  // XSS: debe mostrarse como TEXTO, nunca ejecutarse.
  await page
    .locator('#complaint-detail')
    .fill(`Producto vencido. <script>window.__complaintXss = 1</script> ${marker}`);
  await page
    .locator('#complaint-request')
    .fill('Solicito el cambio del producto o la devolución del monto pagado.');
  await page.locator('#complaint-consent').check();

  await page.getByRole('button', { name: /Registrar reclamo/ }).click();
  await page.waitForURL(/\/libro-de-reclamaciones\/seguimiento\//, { timeout: 25_000 });

  await expect(page.getByRole('heading', { level: 1 })).toContainText('RC-');
  await expect(page.getByText(marker)).toBeVisible();
  await expect(page.getByText(/<script>window\.__complaintXss = 1<\/script>/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Imprimir o guardar PDF/ })).toBeVisible();
  expect(await page.evaluate(() => (window as { __complaintXss?: number }).__complaintXss)).toBeUndefined();

  // El estado se consulta solo con el código opaco: el correlativo no sirve.
  const correlative = await page.goto('/libro-de-reclamaciones/seguimiento/RC-000001');
  expect(correlative?.status()).toBe(404);
  const unknown = await page.goto(`/libro-de-reclamaciones/seguimiento/${'Z'.repeat(24)}`);
  expect(unknown?.status()).toBe(404);
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
  await expect(page.getByText('Platform Admin').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Activar sesión de administrador/ }),
  ).toBeVisible();
  await expect(page.getByPlaceholder(/ADMIN_API_SECRET|token/i)).toHaveCount(0);
});
