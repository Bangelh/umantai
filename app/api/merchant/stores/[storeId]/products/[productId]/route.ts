/**
 * PATCH /api/merchant/stores/:storeId/products/:productId
 *
 * Edita precio/visibilidad/datos comerciales o archiva. El WHERE incluye
 * `store_id`, así que un ID de otra tienda devuelve 404 aunque exista.
 * Nunca hace DELETE: el historial de pedidos conserva su snapshot.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { updateStoreProductCatalog } from '@/lib/store-catalog.server';
import { listStoreProducts } from '@/lib/stores.server';

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
  imageUrl?: unknown;
  priceCents?: unknown;
  unit?: unknown;
  visible?: unknown;
  archived?: unknown;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }

  const body = await readJsonBody<PatchBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  const priceCents =
    body.priceCents === null || body.priceCents === undefined ? undefined : Math.round(Number(body.priceCents));

  const { storeId, productId } = await context.params;

  try {
    await updateStoreProductCatalog(user.id, storeId, productId, {
      name: str(body.name),
      description: str(body.description),
      category: str(body.category),
      brand: str(body.brand),
      imageUrl: str(body.imageUrl),
      priceCents,
      unit: str(body.unit),
      visible: body.visible === undefined ? undefined : body.visible === true,
      archived: body.archived === true,
    });
    const products = await listStoreProducts(user.id, storeId);
    return NextResponse.json({ product: products.find((item) => item.id === productId) ?? null });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
