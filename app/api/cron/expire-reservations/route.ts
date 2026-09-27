import { NextRequest, NextResponse } from 'next/server';
import { expireStaleOrders, isCommerceDbConfigured } from '@/lib/commerce.server';
import { getPrefixedEnv } from '@/lib/env';
import { isAdminApiConfigured, requireAdminToken } from '@/lib/admin.server';

/**
 * GET /api/cron/expire-reservations — libera la reserva de pedidos sin pagar vencidos.
 *
 * Llama a `expire_stale_orders()`, que libera el stock retenido y marca el pedido
 * `expired`. Sin este barrido, cada carrito abandonado deja stock congelado para
 * siempre (el reaper NO se dispara solo: es un cron).
 *
 * Programado en `vercel.json` (`crons`). Mercado Pago puede confirmar un pago
 * después del vencimiento: la migración 002 re-reserva el stock en ese caso.
 *
 * Autorización:
 *   · Si hay `CRON_SECRET` configurado, se exige `Authorization: Bearer <CRON_SECRET>`
 *     (así lo manda Vercel Cron automáticamente).
 *   · Si no, se acepta un `x-admin-token` válido (disparo manual).
 *   · En desarrollo sin ningún secreto configurado, se permite para poder probar.
 *
 * 200 con el conteo · 401 sin autorización · 503 sin base de datos.
 */
function isAuthorized(request: NextRequest): boolean {
  const cronSecret = (getPrefixedEnv('CRON_SECRET') ?? '').trim();
  if (cronSecret) {
    return request.headers.get('authorization') === `Bearer ${cronSecret}`;
  }

  if (requireAdminToken(request).ok) return true;

  // Ni CRON_SECRET ni ADMIN_API_SECRET: entorno de desarrollo.
  return !isAdminApiConfigured();
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isCommerceDbConfigured()) {
    return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
  }

  try {
    const expired = await expireStaleOrders(200);
    if (expired > 0) console.info(`[cron] reservas vencidas liberadas: ${expired}`);
    return NextResponse.json({ ok: true, expiredOrders: expired });
  } catch (error) {
    console.error('[cron] expire-reservations failed:', error);
    return NextResponse.json({ error: 'Could not expire reservations' }, { status: 500 });
  }
}
