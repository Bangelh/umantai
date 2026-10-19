/**
 * GET /api/merchant/master-products?q=&category=&brand=
 *
 * Búsqueda del catálogo maestro para el flujo "Agregar producto". Requiere
 * sesión (cualquier comerciante); no expone datos privados de tiendas.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { listMasterProducts } from '@/lib/master.server';
import { platformErrorResponse } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  try {
    const { products, total } = await listMasterProducts({
      q: params.get('q') ?? '',
      category: params.get('category'),
      brand: params.get('brand'),
      limit: Number(params.get('limit') ?? 30),
    });
    return NextResponse.json({ products, total });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
