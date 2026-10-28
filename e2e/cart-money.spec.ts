/**
 * e2e/cart-money.spec.ts — regresión del error monetario del carrito.
 *
 * Caso reportado: "Arroz a granel · 1 kg · S/ 12,00" se mostraba en `/cart` como
 * S/ 1200,00. La causa estaba en el borde producto → carrito: el precio base
 * viajaba en soles y el de la variante en centavos.
 *
 * El test NO crea pedidos: se detiene en `/cart`, así que no deja residuos en la
 * base de staging. Busca el primer producto CON variantes publicado (el bug solo
 * aparecía con variantes) y verifica el importe contra el que muestra la ficha.
 */

import { expect, test, type Page } from '@playwright/test';

interface DiscoveryProduct {
  productSlug: string;
  storeSlug: string;
}

/** "S/ 12,00" → 12 (soles). Los importes del carrito están en unidades. */
function parseAmount(label: string): number {
  const match = label.match(/(\d[\d.]*),(\d{2})/);
  if (!match) throw new Error(`importe no reconocido: ${label}`);
  const integer = match[1].replace(/\./g, '');
  return Number(`${integer}.${match[2]}`);
}

function formatAmount(units: number): string {
  return `S/ ${units.toFixed(2).replace('.', ',')}`;
}

/**
 * Primer producto con al menos un eje de variación. Itera los resultados del
 * buscador porque en staging el catálogo cambia y no queremos atar el test a un
 * slug concreto.
 */
async function findProductWithVariants(page: Page, products: DiscoveryProduct[]) {
  for (const product of products.slice(0, 12)) {
    await page.goto(`/${product.storeSlug}/p/${product.productSlug}`);
    const status = page.getByRole('heading', { level: 1 });
    if ((await status.count()) === 0) continue;

    const price = page.locator('section[aria-label] div.font-mono').first();
    if ((await price.count()) === 0) continue;

    const label = (await price.textContent()) ?? '';
    if (!/S\/\s*\d/.test(label)) continue;

    // Con variantes aparecen los `fieldset` de opciones.
    if ((await page.locator('section fieldset').count()) === 0) continue;

    return {
      storeSlug: product.storeSlug,
      productSlug: product.productSlug,
      unitPrice: parseAmount(label),
    };
  }
  return null;
}

test.describe('carrito: contrato monetario', () => {
  test('una unidad con variante cuesta lo que dice la ficha, no ×100', async ({ page, request }) => {
    const response = await request.get('/api/search?limit=30');
    test.skip(!response.ok(), 'el buscador no respondió');
    const payload = (await response.json()) as { products?: DiscoveryProduct[] };
    const products = payload.products ?? [];
    test.skip(products.length === 0, 'staging sin productos publicados');

    const target = await findProductWithVariants(page, products);
    test.skip(target === null, 'staging sin productos con variantes');
    if (!target) return;

    // Ficha: el importe aparece UNA vez (antes se repetía y el de arriba no
    // reaccionaba a la variante).
    await expect(page.getByText(formatAmount(target.unitPrice)).first()).toBeVisible();

    // Elige la primera opción con stock y agrega una unidad.
    const groups = page.locator('section fieldset');
    for (let index = 0; index < (await groups.count()); index += 1) {
      const options = groups.nth(index).locator('button[aria-pressed]');
      const total = await options.count();
      if (total === 0) continue;
      let target2 = options.first();
      for (let option = 0; option < total; option += 1) {
        const candidate = options.nth(option);
        if (!/Sin stock|Out of stock/i.test((await candidate.textContent()) ?? '')) {
          target2 = candidate;
          break;
        }
      }
      await target2.click();
    }

    const unitPrice = parseAmount(
      (await page.locator('section[aria-label] div.font-mono').first().textContent()) ?? '',
    );
    await page.getByRole('button', { name: /Agregar al carrito/ }).click();
    await page.goto('/cart');

    await expect(page.getByRole('heading', { name: /Tu carrito/ })).toBeVisible();

    // 1 unidad → el mismo importe de la ficha.
    await expect(page.getByText(formatAmount(unitPrice)).first()).toBeVisible();
    // Regresión explícita: nada se multiplica por 100.
    await expect(page.getByText(formatAmount(unitPrice * 100))).toHaveCount(0);

    // 2 unidades → el doble.
    await page
      .getByRole('button', { name: new RegExp(`Aumentar cantidad`) })
      .first()
      .click();
    await expect(page.getByText(formatAmount(unitPrice * 2)).first()).toBeVisible();
  });
});
