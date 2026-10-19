/**
 * GET /api/merchant/stores/:storeId/orders
 *
 * Pedidos de UNA tienda. `requireStoreAccess` corre dentro de `listStoreOrders`
 * antes del SELECT, y el SQL filtra `o.store_id`. No hay forma de pedir "todos
 * los pedidos de la plataforma" desde este endpoint.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { listStoreOrders } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const { storeId } = await context.params;
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '50');

  try {
    const orders = await listStoreOrders(
      user.id,
      storeId,
      Number.isFinite(limit) ? limit : 50,
    );
    return NextResponse.json({ orders });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
