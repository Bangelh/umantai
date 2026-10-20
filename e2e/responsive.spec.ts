import { expect, test } from '@playwright/test';

/**
 * Responsive + tema en cuatro viewports reales:
 * móvil pequeño (320×568), móvil estándar (390×844), tablet (768×1024),
 * desktop (1440×900).
 *
 * La densidad de UMANTAI se mantiene: el test falla si aparece scroll
 * horizontal o si una lista de resultados se convierte en cards gigantes
 * (altura de fila > 140 px en móvil).
 */

const VIEWPORTS = [
  { name: 'mobile-small', width: 320, height: 568 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

const PAGES = ['/', '/cart', '/ingresar', '/legal/privacidad'];

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}×${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const path of PAGES) {
      test(`${path} sin overflow horizontal`, async ({ page }) => {
        await page.goto(path);
        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(
          metrics.scrollWidth,
          `${path} desborda ${metrics.scrollWidth - metrics.innerWidth}px`,
        ).toBeLessThanOrEqual(metrics.innerWidth + 2);
      });
    }

    test('tema claro/oscuro mantiene contraste en el cuerpo', async ({ page }) => {
      await page.goto('/');
      for (const theme of ['dark', 'light'] as const) {
        await page.evaluate((value) => {
          window.localStorage.setItem('umantai_theme', value);
          document.documentElement.dataset.theme = value;
          document.documentElement.style.colorScheme = value;
        }, theme);

        const colors = await page.evaluate(() => {
          const style = getComputedStyle(document.body);
          return { background: style.backgroundColor, color: style.color };
        });
        expect(colors.background).not.toBe(colors.color);
      }
    });

    if (viewport.width <= 390) {
      test('resultados de búsqueda siguen siendo filas densas', async ({ page }) => {
        await page.goto('/');
        const search = page.getByRole('search');
        await search.getByRole('textbox').fill('arroz');
        await search.getByRole('button', { name: /^Buscar$/ }).click();
        const rows = page.getByRole('region', { name: /Resultados/i }).locator('ul > li');
        const count = await rows.count();
        test.skip(count === 0, 'sin resultados en staging');
        const box = await rows.first().boundingBox();
        expect(box?.height ?? 0).toBeLessThanOrEqual(140);
      });
    }
  });
}
