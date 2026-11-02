import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  activateStoreAsAdmin,
  createProductViaApi,
  createStoreViaApi,
  loginUi,
  signUpUi,
  uniqueEmail,
  uniqueSlug,
} from './helpers';

/**
 * Panel del merchant: lista operable + detalle de pedido.
 *
 * Requiere `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` de una cuenta con
 * `platform_admins`: activar la tienda QA es una acción de administración y el test
 * no la simula desde el cliente. Sin esas variables el test se salta.
 *
 * El pedido se crea comprando de verdad por la UI (invitado) y queda en
 * `pending_payment`; no se paga, así que la reserva caduca sola.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const SHOTS = '.tools/shots';

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
}

/** Contraste real del texto contra el fondo efectivo (mezcla alfa hacia arriba). */
async function contrast(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgba | null => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(/[,/]/).map((part) => Number(part.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const luminance = ({ r, g, b }: Rgba) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    const foreground = parse(getComputedStyle(element).color);
    if (!foreground) return 0;

    // Fondo efectivo: se apila hacia arriba hasta encontrar un color opaco.
    let background: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    const layers: Rgba[] = [];
    let node: Element | null = element;
    while (node) {
      const raw = parse(getComputedStyle(node).backgroundColor);
      if (raw && raw.a > 0) {
        layers.push(raw);
        if (raw.a >= 1) break;
      }
      node = node.parentElement;
    }
    if (layers.length > 0) {
      background = layers.pop() as Rgba;
      while (layers.length > 0) {
        const top = layers.pop() as Rgba;
        background = {
          r: top.r * top.a + background.r * (1 - top.a),
          g: top.g * top.a + background.g * (1 - top.a),
          b: top.b * top.a + background.b * (1 - top.a),
          a: 1,
        };
      }
    }

    const fg = luminance(foreground);
    const bg = luminance(background);
    const lighter = Math.max(fg, bg);
    const darker = Math.min(fg, bg);
    return (lighter + 0.05) / (darker + 0.05);
  });
}

test.describe.serial('detalle de pedido del merchant', () => {
  test.skip(!ADMIN_EMAIL, 'define E2E_ADMIN_EMAIL para activar la tienda QA');

  test('pending_payment se lee como "Esperando pago", sin preparar y con reserva visible', async ({
    page,
    browser,
  }) => {
    // ── 1. Comercio nuevo (inactivo) con un producto ─────────────────────────
    const email = uniqueEmail('e2e-orders');
    console.log(`[e2e] merchant=${email}`);
    await signUpUi(page, email, 'E2E Pedidos');
    const store = await createStoreViaApi(page, 'Tienda E2E Pedidos', uniqueSlug('e2e-orders'));
    const product = await createProductViaApi(page, store.id, {
      name: 'Producto E2E Pedidos',
      priceCents: 2500,
      stock: 5,
    });

    // ── 2. Platform Admin activa la tienda (contexto aparte) ─────────────────
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginUi(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    // Canje directo de la sesión de usuario por la cookie de Platform Admin. Se hace
    // por API (no por el botón del panel) para no depender del momento de hidratación
    // de React: es el MISMO endpoint que usa la UI.
    const sessionResponse = await adminPage.request.post('/api/admin/session', { data: {} });
    expect(
      sessionResponse.ok(),
      `activar sesión admin falló: ${sessionResponse.status()} ${await sessionResponse.text()}`,
    ).toBeTruthy();
    expect(((await sessionResponse.json()) as { authenticated?: boolean }).authenticated).toBe(true);
    await activateStoreAsAdmin(adminPage, store.id);
    await adminContext.close();

    // ── 3. Compra real de un invitado (queda pending_payment) ────────────────
    await page.goto(`/${store.slug}/p/${product.slug}`);
    await page.getByRole('button', { name: /Agregar al carrito/ }).click();
    await page.goto('/cart');
    await page.getByLabel(/Correo/).fill(uniqueEmail('e2e-orders-buyer'));
    await page.getByRole('button', { name: /Revisar pedido/ }).click();
    await page.getByRole('button', { name: /Confirmar compra/ }).click();
    await page.waitForURL(/\/pedido\//, { timeout: 30_000 });

    const orderNumber = (
      (await page.getByText(/UM-\d{4}-\d+/).first().textContent()) ?? ''
    ).trim();
    expect(orderNumber).toMatch(/^UM-\d{4}-\d+$/);

    // ── 4. La fila de la lista abre el detalle y es tappable ─────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/negocio/${store.id}`);

    const row = page.getByRole('link', { name: new RegExp(orderNumber) });
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // El estado en la lista es el mismo copy que en el detalle.
    await expect(row.getByText('Esperando pago')).toBeVisible();
    // El grupo de pedidos vivos encabeza la lista (fuera de la fila).
    await expect(page.getByRole('heading', { name: 'Requieren atención' })).toBeVisible();

    await setTheme(page, 'light');
    await page.screenshot({ path: `${SHOTS}/merchant-orders-light-mobile.png` });
    await setTheme(page, 'dark');
    await page.screenshot({ path: `${SHOTS}/merchant-orders-dark-mobile.png` });

    await page.setViewportSize({ width: 1280, height: 900 });
    await setTheme(page, 'light');
    await page.screenshot({ path: `${SHOTS}/merchant-orders-light-desktop.png` });
    await setTheme(page, 'dark');
    await page.screenshot({ path: `${SHOTS}/merchant-orders-dark-desktop.png` });

    // ── 5. Detalle ───────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, 'light');
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/negocio/${store.id}/pedidos/`));

    await expect(page.getByRole('heading', { name: orderNumber })).toBeVisible();
    await expect(page.getByText('Esperando pago').first()).toBeVisible();
    // El aviso vive en el bloque de espera de pago; puede aparecer también dentro
    // de la acción sugerida, así que se comprueba el primero.
    await expect(page.getByText('No prepares este pedido todavía.').first()).toBeVisible();
    await expect(page.getByText(/Los productos están reservados hasta/).first()).toBeVisible();
    await expect(page.getByText('Producto E2E Pedidos')).toBeVisible();
    await expect(page.getByText('S/ 25,00').first()).toBeVisible();
    await expect(page.getByText('Pago pendiente')).toBeVisible();
    await expect(page.getByText('Recojo en tienda')).toBeVisible();

    // No hay acciones de preparación para un pedido impago, y no se muestra
    // ningún casillero inexistente.
    await expect(page.getByRole('button', { name: /Preparar/ })).toHaveCount(0);
    await expect(page.getByText(/Retiro en casillero/i)).toHaveCount(0);

    // Contraste del número de pedido (texto principal sobre el fondo del panel).
    expect(await contrast(page.getByRole('heading', { name: orderNumber }))).toBeGreaterThanOrEqual(4.5);

    await page.screenshot({ path: `${SHOTS}/merchant-order-light-mobile.png` });
    await setTheme(page, 'dark');
    await page.screenshot({ path: `${SHOTS}/merchant-order-dark-mobile.png` });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${SHOTS}/merchant-order-dark-desktop.png` });
    await setTheme(page, 'light');
    await page.screenshot({ path: `${SHOTS}/merchant-order-light-desktop.png` });
  });
});
