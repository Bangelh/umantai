/**
 * GET /api/account/orders — historial del cliente autenticado.
 *
 * Solo pedidos con `orders.user_id = session.user.id`. NO se incluyen pedidos
 * de invitado con el mismo email: el email todavía no está verificado y
 * emparejarlo permitiría reclamar compras ajenas. El guest checkout sigue
 * funcionando; simplemente no aparece en el historial hasta que exista
 * verificación de email.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { listCustomerOrders } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  try {
    return NextResponse.json({ orders: await listCustomerOrders(user.id) });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
