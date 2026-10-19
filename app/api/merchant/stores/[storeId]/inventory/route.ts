/**
 * POST /api/merchant/stores/:storeId/inventory
 *
 * { productId, variantKey, delta, reason }
 *
 * Ajuste de stock (ledger append-only). La función de datos valida membresía,
 * producto y variante, y llama a `inventory_apply_movement` con el store_id
 * explícito; la base rechaza stock negativo o menor a lo reservado.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { adjustStoreVariantStock } from '@/lib/store-catalog.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface StockBody {
  productId?: unknown;
  variantKey?: unknown;
  delta?: unknown;
  reason?: unknown;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  const body = await readJsonBody<StockBody>(request);
  if (!body || typeof body.productId !== 'string') {
    return NextResponse.json({ error: 'productId es obligatorio.', code: 'invalid_input' }, { status: 400 });
  }

  const { storeId } = await context.params;
  try {
    const stock = await adjustStoreVariantStock(
      user.id,
      storeId,
      body.productId,
      typeof body.variantKey === 'string' ? body.variantKey : '',
      Number(body.delta),
      typeof body.reason === 'string' ? body.reason : '',
    );
    return NextResponse.json({ stock });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
