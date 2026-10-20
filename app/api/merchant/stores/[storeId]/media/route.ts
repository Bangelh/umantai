/**
 * POST /api/merchant/stores/:storeId/media (multipart/form-data)
 *
 *   file       obligatorio (JPG/PNG/WebP, <= 2 MB)
 *   scope      store_logo | product_image
 *   productId  obligatorio para product_image
 *
 * La autorización se valida ANTES de guardar: no existe forma de subir una
 * imagen para el producto de otra tienda. La key la genera el servidor.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { CatalogError } from '@/lib/catalog';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { putImage } from '@/lib/storage.server';
import { requireStoreAccess } from '@/lib/stores.server';
import { consumeRateLimit } from '@/lib/rate-limit.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }

  // 10 subidas por minuto y usuario: frena bucles sin molestar el uso normal.
  const limit = consumeRateLimit(`media:${user.id}`, 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Demasiadas subidas seguidas. Espera un momento.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const { storeId } = await context.params;
  try {
    await requireStoreAccess(user.id, storeId);

    const form = await request.formData();
    const file = form.get('file');
    const scope = String(form.get('scope') ?? '');
    if (!(file instanceof File)) {
      throw new CatalogError('media_missing', 'Falta el archivo de imagen.', 400);
    }
    if (scope !== 'store_logo' && scope !== 'product_image') {
      throw new CatalogError('media_invalid_scope', 'scope debe ser store_logo o product_image.', 400);
    }

    const sql = requirePlatformSql();
    let productId: string | null = null;
    if (scope === 'product_image') {
      productId = String(form.get('productId') ?? '').trim();
      if (!productId) {
        throw new CatalogError('media_invalid_scope', 'productId es obligatorio para product_image.', 400);
      }
      const rows = await sql`
        SELECT id FROM store_products
         WHERE id = ${productId}::uuid AND store_id = ${storeId}::uuid
         LIMIT 1
      `;
      if (!rows[0]) {
        throw new CatalogError('store_product_not_found', 'Producto no encontrado en esta tienda.', 404);
      }
    }

    const media = await putImage({
      scope,
      file,
      userId: user.id,
      storeId,
      storeProductId: productId,
    });

    if (scope === 'store_logo') {
      await sql`
        UPDATE stores SET logo_url = ${media.url}, updated_at = NOW()
         WHERE id = ${storeId}::uuid
      `;
    } else {
      await sql`
        UPDATE store_products SET image_url = ${media.url}, updated_at = NOW()
         WHERE id = ${productId}::uuid AND store_id = ${storeId}::uuid
      `;
    }

    return NextResponse.json({ media }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
