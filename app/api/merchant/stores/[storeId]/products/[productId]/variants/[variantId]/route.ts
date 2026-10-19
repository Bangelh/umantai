/**
 * PATCH /api/merchant/stores/:storeId/products/:productId/variants/:variantId
 * Edita SKU/precio/estado o archiva una variante. Nunca cruza de tienda.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { updateStoreVariant } from '@/lib/store-catalog.server';
import { listStoreProducts } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string; productId: string; variantId: string }>;
}

interface PatchBody {
  sku?: unknown;
  priceCents?: unknown;
  active?: unknown;
  archived?: unknown;
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

  const { storeId, productId, variantId } = await context.params;
  try {
    await updateStoreVariant(user.id, storeId, productId, variantId, {
      sku: typeof body.sku === 'string' ? body.sku : undefined,
      priceCents:
        body.priceCents === null || body.priceCents === undefined
          ? undefined
          : Math.round(Number(body.priceCents)),
      active: body.active === undefined ? undefined : body.active === true,
      archived: body.archived === true,
    });
    const products = await listStoreProducts(user.id, storeId);
    return NextResponse.json({ product: products.find((item) => item.id === productId) ?? null });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
