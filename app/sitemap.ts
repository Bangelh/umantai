import type { MetadataRoute } from 'next';

import { businessConfig } from '@/config/business';
import { LEGAL_SLUGS } from '@/lib/legal';
import { baseProductsData } from '@/lib/products';
import { getPlatformSql } from '@/lib/platform-db.server';

// El catálogo de tiendas cambia en runtime; no se congela en el build.
export const dynamic = 'force-dynamic';

/**
 * sitemap.xml — páginas públicas indexables.
 *
 * Incluye el catálogo legacy y, si hay base configurada, las vitrinas de tiendas
 * ACTIVAS y sus productos VISIBLES. Nunca expone tiendas inactivas ni productos
 * ocultos.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = businessConfig.siteUrl.replace(/\/+$/, '');

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/products`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/vender`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/contacto`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/legal`, changeFrequency: 'monthly', priority: 0.3 },
    ...LEGAL_SLUGS.map((slug) => ({
      url: `${base}/legal/${slug}`,
      changeFrequency: 'yearly' as const,
      priority: 0.3,
    })),
  ];

  const legacyProducts: MetadataRoute.Sitemap = baseProductsData.map((product) => ({
    url: `${base}/products/${product.slug}`,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));

  let platformRoutes: MetadataRoute.Sitemap = [];
  const sql = getPlatformSql();

  if (sql) {
    try {
      const rows = await sql`
        SELECT s.slug AS store_slug, sp.slug AS product_slug, sp.updated_at
          FROM store_products sp
          JOIN stores s ON s.id = sp.store_id
         WHERE s.active = TRUE AND sp.visible = TRUE
         ORDER BY sp.updated_at DESC
         LIMIT 2000
      `;

      const stores = new Map<string, string>();
      const products: MetadataRoute.Sitemap = [];

      for (const row of rows as Array<Record<string, unknown>>) {
        const storeSlug = String(row.store_slug);
        const productSlug = String(row.product_slug);
        stores.set(storeSlug, String(row.updated_at ?? ''));
        products.push({
          url: `${base}/${storeSlug}/p/${productSlug}`,
          changeFrequency: 'weekly',
          priority: 0.6,
          lastModified: row.updated_at ? new Date(String(row.updated_at)) : undefined,
        });
      }

      platformRoutes = [
        ...[...stores.keys()].map((storeSlug) => ({
          url: `${base}/${storeSlug}`,
          changeFrequency: 'daily' as const,
          priority: 0.8,
        })),
        ...products,
      ];
    } catch (error) {
      // Un sitemap nunca debe tumbar el sitio; se sirve el catálogo estático.
      console.error('[sitemap] no se pudo leer el catálogo multi-tienda', error);
    }
  }

  return [...staticRoutes, ...legacyProducts, ...platformRoutes];
}
