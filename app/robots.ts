import type { MetadataRoute } from 'next';

import { businessConfig } from '@/config/business';

/**
 * robots.txt — deja indexar el catálogo y los documentos legales.
 *
 * Bloquea todo lo que no es contenido público:
 *   /admin, /api, /debug, /kiosk (pantalla operativa), /pedido/<token> (link
 *   privado de un pedido), /cart y /list (estado local del visitante).
 */
export default function robots(): MetadataRoute.Robots {
  const base = businessConfig.siteUrl;

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/api/',
          '/debug',
          '/kiosk',
          '/pedido/',
          '/cart',
          '/list',
          '/cuenta',
          '/negocio',
          '/ingresar',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
