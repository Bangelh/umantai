import { expect, test, type Page } from '@playwright/test';

/**
 * Regresión del CTA principal del checkout.
 *
 * El bug original: `bg-brandtext-body-lg` (sin espacio) dejaba el botón sin
 * fondo, con `text-background` encima del fondo de la página. Era clickeable y
 * `toBeVisible()` pasaba, pero tenía contraste 1:1 y 24 px de alto en móvil.
 *
 * Este test mide lo que `toBeVisible()` no ve: fondo real, contraste, opacidad y
 * caja táctil, en claro/oscuro y en móvil/desktop.
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const THEMES = ['light', 'dark'] as const;

const EMAIL = `cta-${Date.now()}@umantai.test`;

interface Product {
  productSlug: string;
  storeSlug: string;
}

function luminance([r, g, b]: number[]): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parseRgb(value: string): number[] | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  return match[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseRgb(foreground);
  const bg = parseRgb(background);
  if (!fg || !bg) return null;
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

async function seedCartWithOneProduct(page: Page): Promise<void> {
  const response = await page.request.get('/api/search?limit=20');
  expect(response.ok(), 'la búsqueda debe responder').toBeTruthy();
  const payload = (await response.json()) as { products?: Product[] };
  const product = payload.products?.[0];
  if (!product) {
    test.skip(true, 'staging sin productos publicados');
    return;
  }

  await page.goto(`/${product.storeSlug}/p/${product.productSlug}`);

  const fieldsets = page.locator('section fieldset');
  for (let index = 0; index < (await fieldsets.count()); index += 1) {
    const options = fieldsets.nth(index).locator('button[aria-pressed]');
    for (let option = 0; option < (await options.count()); option += 1) {
      const candidate = options.nth(option);
      if (!/Sin stock|Out of stock/i.test((await candidate.textContent()) ?? '')) {
        await candidate.click();
        break;
      }
    }
  }

  await page.getByRole('button', { name: /Agregar al carrito/ }).click();
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`CTA "Revisar pedido" visible y con contraste · ${theme} · ${viewport.name}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      test.setTimeout(90_000);

      await context.addCookies([
        {
          name: 'umantai_theme',
          value: theme,
          domain: new URL(baseURL ?? 'https://umantai.com').hostname,
          path: '/',
        },
      ]);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme });

      await seedCartWithOneProduct(page);
      await page.goto('/cart');
      await page.getByLabel(/Correo/).fill(EMAIL);

      const cta = page.getByRole('button', { name: 'Revisar pedido', exact: true });
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAccessibleName('Revisar pedido');
      await cta.scrollIntoViewIfNeeded();

      const box = await cta.boundingBox();
      expect(box, 'el CTA debe tener caja').not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      // Objetivo táctil: 44 px como mínimo; el diseño usa 56 px.
      expect(box!.height).toBeGreaterThanOrEqual(44);

      const styles = await cta.evaluate((element) => {
        const button = element as HTMLButtonElement;
        const style = getComputedStyle(button);
        let background = style.backgroundColor;
        let node: HTMLElement | null = button;
        while (node && (background === 'rgba(0, 0, 0, 0)' || background === 'transparent')) {
          node = node.parentElement;
          if (!node) break;
          background = getComputedStyle(node).backgroundColor;
        }
        const rect = button.getBoundingClientRect();
        return {
          backgroundColor: style.backgroundColor,
          effectiveBackground: background,
          color: style.color,
          opacity: style.opacity,
          visibility: style.visibility,
          display: style.display,
          disabled: button.disabled,
          inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0,
        };
      });

      expect(styles.display).not.toBe('none');
      expect(styles.visibility).toBe('visible');
      expect(Number(styles.opacity)).toBeGreaterThan(0.5);
      expect(styles.disabled).toBe(false);
      expect(styles.backgroundColor, 'el CTA no puede quedar transparente').not.toBe(
        'rgba(0, 0, 0, 0)',
      );

      const ratio = contrastRatio(styles.color, styles.effectiveBackground);
      expect(ratio, 'no se pudo calcular el contraste').not.toBeNull();
      expect(ratio!, 'el texto del CTA necesita contraste AA (4.5:1)').toBeGreaterThanOrEqual(4.5);

      await page.screenshot({
        path: testInfo.outputPath(`cta-${theme}-${viewport.name}.png`),
        fullPage: false,
      });
    });
  }
}
