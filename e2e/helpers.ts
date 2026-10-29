import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Contraseña de cuentas E2E (staging/test). No se usa en Producción. */
export const E2E_PASSWORD = process.env.E2E_PASSWORD || 'E2E-Staging-Passw0rd!';

export function uniqueEmail(prefix = 'e2e'): string {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return `${prefix}+${stamp}@umantai.test`;
}

export function uniqueSlug(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

export async function signUpUi(page: Page, email: string, name = 'E2E Tester'): Promise<void> {
  await page.goto('/ingresar');
  await page.getByRole('tab', { name: /Crear cuenta/ }).click();
  await page.getByLabel('Nombre', { exact: true }).fill(name);
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /^Crear cuenta$/ }).click();
  await page.waitForURL(/\/cuenta/, { timeout: 20_000 });
}

export async function loginUi(page: Page, email: string, password = E2E_PASSWORD): Promise<void> {
  await page.goto('/ingresar');
  await page.getByRole('tab', { name: /Ya tengo cuenta/ }).click();
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^Ingresar$/ }).click();
  await page.waitForURL(/\/cuenta/, { timeout: 20_000 });
}

export async function logoutUi(page: Page): Promise<void> {
  await page.goto('/cuenta');
  await page.getByRole('button', { name: /^Salir$/ }).click();
  await page.waitForURL('/');
}

interface OutboxMessage {
  purpose: string;
  recipient: string;
  subject: string;
  actionUrl: string | null;
}

/** Lee el último correo de test-mode. Falla si el entorno no lo habilita. */
export async function latestOutbox(
  request: APIRequestContext,
  email: string,
  purpose: 'verify_email' | 'reset_password',
): Promise<OutboxMessage> {
  const response = await request.get(
    `/api/auth/test/outbox?email=${encodeURIComponent(email)}&purpose=${purpose}`,
  );
  expect(response.ok(), 'el outbox de test debe estar habilitado en staging').toBeTruthy();
  const payload = (await response.json()) as { message: OutboxMessage | null };
  expect(payload.message?.actionUrl, `sin correo ${purpose} para ${email}`).toBeTruthy();
  return payload.message as OutboxMessage;
}

/** Crea una tienda vía API (misma sesión de la página) y devuelve id/slug. */
export async function createStoreViaApi(
  page: Page,
  name: string,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const response = await page.request.post('/api/merchant/stores', {
    data: {
      name,
      slug,
      category: 'abarrotes',
      description: 'Tienda creada por la suite E2E.',
      // Ubicación canónica: UBIGEO de Miraflores (Lima) + pin.
      location: {
        ubigeo: '150122',
        address: 'Av. Larco 123',
        reference: 'Suite E2E',
        latitude: -12.1211,
        longitude: -77.0297,
        source: 'map_pin',
      },
    },
  });
  expect(response.ok(), `createStore falló: ${response.status()}`).toBeTruthy();
  const payload = (await response.json()) as { store: { id: string; slug: string } };
  return payload.store;
}

/** Agrega un producto propio vía API. */
export async function createProductViaApi(
  page: Page,
  storeId: string,
  input: { name: string; priceCents: number; stock: number },
): Promise<{ id: string; slug: string }> {
  const response = await page.request.post(`/api/merchant/stores/${storeId}/products`, {
    data: {
      name: input.name,
      priceCents: input.priceCents,
      initialStock: input.stock,
      unit: 'unidad',
      category: 'abarrotes',
      visible: true,
    },
  });
  expect(response.ok(), `createProduct falló: ${response.status()}`).toBeTruthy();
  const payload = (await response.json()) as { product: { id: string; slug: string } };
  return payload.product;
}

/** Activa una tienda como Platform Admin (requiere sesión de admin ya activa). */
export async function activateStoreAsAdmin(page: Page, storeId: string): Promise<void> {
  const response = await page.request.patch('/api/admin/stores', {
    data: { storeId, active: true },
  });
  expect(response.ok(), `activar tienda falló: ${response.status()}`).toBeTruthy();
}
