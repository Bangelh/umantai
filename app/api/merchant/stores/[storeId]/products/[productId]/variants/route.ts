/**
 * POST /api/merchant/stores/:storeId/products/:productId/variants
 *
 * Agrega una variante vendible. La tienda/producto se validan contra
 * `store_members`; el SKU es único por tienda y `variant_key` es la identidad
 * que comparte `inventory`.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { CatalogError } from '@/lib/catalog';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { addStoreVariant } from '@/lib/store-catalog.server';
import { listStoreProducts } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string; productId: string }>;
}

interface AddVariantBody {
  optionValues?: unknown;
  sku?: unknown;
  priceCents?: unknown;
  initialStock?: unknown;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  const body = await readJsonBody<AddVariantBody>(request);
  if (!body || !body.optionValues || typeof body.optionValues !== 'object') {
    return NextResponse.json(
      { error: 'optionValues es obligatorio (ej. {"talla":"M"}).', code: 'invalid_variant' },
      { status: 400 },
    );
  }

  const { storeId, productId } = await context.params;
  try {
    const variant = await addStoreVariant(user.id, storeId, productId, {
      optionValues: body.optionValues as Record<string, unknown>,
      sku: typeof body.sku === 'string' ? body.sku : null,
      priceCents:
        body.priceCents === null || body.priceCents === undefined
          ? null
          : Math.round(Number(body.priceCents)),
      initialStock: Number(body.initialStock ?? 0),
    });
    const products = await listStoreProducts(user.id, storeId);
    return NextResponse.json(
      { variant, product: products.find((item) => item.id === productId) ?? null },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CatalogError) return platformErrorResponse(error);
    return platformErrorResponse(error);
  }
}
