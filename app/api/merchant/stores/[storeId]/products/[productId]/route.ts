/**
 * PATCH /api/merchant/stores/:storeId/products/:productId
 *
 * Actualiza precio/visibilidad/datos comerciales. El WHERE incluye `store_id`,
 * así que un ID de otra tienda devuelve 404 aunque el producto exista.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { updateStoreProduct } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string; productId: string }>;
}

interface PatchBody {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  brand?: unknown;
  priceCents?: unknown;
  visible?: unknown;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const body = await readJsonBody<PatchBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  const priceCents =
    body.priceCents === null || body.priceCents === undefined ? null : Number(body.priceCents);

  const { storeId, productId } = await context.params;

  try {
    const product = await updateStoreProduct(user.id, storeId, productId, {
      name: strOrNull(body.name),
      description: strOrNull(body.description),
      category: strOrNull(body.category),
      brand: strOrNull(body.brand),
      priceCents: priceCents === null ? null : Math.round(priceCents),
      visible: body.visible === undefined ? null : body.visible === true,
    });
    return NextResponse.json({ product });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
