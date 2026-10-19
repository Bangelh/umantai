import type { MetadataRoute } from 'next';

import { businessConfig } from '@/config/business';
import { LEGAL_SLUGS } from '@/lib/legal';
import { baseProductsData } from '@/lib/products';

/**
 * sitemap.xml — páginas públicas indexables.
 *
 * Los productos salen del catálogo base (`baseProductsData`); las ediciones del
 * panel viven en `product_overrides` y no cambian las URLs, así que el sitemap
 * no necesita consultar la base.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = businessConfig.siteUrl.replace(/\/+$/, '');
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/products`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/contacto`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/legal`, changeFrequency: 'monthly', priority: 0.3 },
    ...LEGAL_SLUGS.map((slug) => ({
      url: `${base}/legal/${slug}`,
      changeFrequency: 'yearly' as const,
      priority: 0.3,
    })),
  ];

  const products: MetadataRoute.Sitemap = baseProductsData.map((product) => ({
    url: `${base}/products/${product.slug}`,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));

  return [...staticRoutes, ...products];
}
