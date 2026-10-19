/**
 * POST /api/admin/media (multipart/form-data) — imagen de MasterProduct.
 * Plataforma, no merchant. Requiere x-admin-token.
 */

import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { CatalogError } from '@/lib/catalog';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { putImage } from '@/lib/storage.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
  }

  try {
    const form = await request.formData();
    const file = form.get('file');
    const masterProductId = String(form.get('masterProductId') ?? '').trim();
    if (!(file instanceof File)) {
      throw new CatalogError('media_missing', 'Falta el archivo de imagen.', 400);
    }
    if (!masterProductId) {
      throw new CatalogError('media_invalid_scope', 'masterProductId es obligatorio.', 400);
    }

    const sql = requirePlatformSql();
    const rows = await sql`
      SELECT id FROM master_products WHERE id = ${masterProductId}::uuid LIMIT 1
    `;
    if (!rows[0]) {
      throw new CatalogError('master_product_not_found', 'Producto maestro no encontrado.', 404);
    }

    const media = await putImage({
      scope: 'master_image',
      file,
      userId: null,
      masterProductId,
    });

    await sql`
      UPDATE master_products SET image_url = ${media.url}, updated_at = NOW()
       WHERE id = ${masterProductId}::uuid
    `;

    return NextResponse.json({ media }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
