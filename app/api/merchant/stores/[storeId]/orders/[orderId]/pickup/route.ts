/**
 * POST /api/merchant/stores/:storeId/orders/:orderId/pickup
 *
 * El comerciante ingresa el PIN que le dicta el cliente. El canje consolida el
 * inventario y deja el pedido `picked_up` con el mismo motor del kiosco.
 *
 * El PIN se valida ANTES contra la tienda: conocer un PIN de otra tienda no
 * permite canjearlo desde este panel.
 */

import { NextResponse } from 'next/server';
import { redeemPickupCode } from '@/lib/commerce.server';
import { getSessionUser } from '@/lib/auth.server';
import { notifyLowStockAfterSale } from '@/lib/notifications.server';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { requireStoreAccess } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FAILURE_COPY: Record<string, string> = {
  pickup_code_not_found: 'Ese PIN no corresponde a un pedido de esta tienda.',
  pickup_code_expired: 'El PIN venció. Emite uno nuevo marcando el pedido listo otra vez.',
  pickup_code_locked: 'Demasiados intentos. Pide ayuda a un supervisor.',
  pickup_code_already_used: 'Ese PIN ya se usó para entregar el pedido.',
  pickup_rate_limited: 'Demasiados intentos seguidos. Espera un par de minutos.',
};

interface RouteContext {
  params: Promise<{ storeId: string; orderId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const { storeId, orderId } = await context.params;
  if (!UUID_PATTERN.test(orderId)) {
    return NextResponse.json(
      { error: 'Pedido inválido.', code: 'invalid_order_id' },
      { status: 400 },
    );
  }

  const gate = await rateLimitGate(request, 'merchant-order-pickup', {
    limit: 20,
    windowMs: 60_000,
    key: `order-pickup:${user.id}`,
  });
  if (gate) return gate;

  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return NextResponse.json(
      { error: 'Solicitud inválida.', code: 'invalid_body' },
      { status: 400 },
    );
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^[0-9]{6}$/.test(code)) {
    return NextResponse.json(
      { error: 'El PIN son 6 números.', code: 'invalid_code_format' },
      { status: 400 },
    );
  }

  try {
    await requireStoreAccess(user.id, storeId, 'admin');
    const sql = requirePlatformSql();

    const rows = (await sql`
      SELECT pc.id
        FROM pickup_codes pc
        JOIN orders o ON o.id = pc.order_id
       WHERE pc.code = ${code}
         AND o.id = ${orderId}::uuid
         AND o.store_id = ${storeId}::uuid
       LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) {
      return NextResponse.json(
        { error: FAILURE_COPY.pickup_code_not_found, code: 'pickup_code_not_found' },
        { status: 200 },
      );
    }

    const result = await redeemPickupCode({
      code,
      redeemedBy: `merchant:${user.id}`,
      deviceId: `panel:${storeId}`,
    });

    if (!result.ok) {
      const failureCode = result.error_code ?? 'pickup_code_not_found';
      return NextResponse.json(
        {
          error: FAILURE_COPY[failureCode] ?? 'No se pudo validar el PIN.',
          code: failureCode,
        },
        { status: failureCode === 'pickup_rate_limited' ? 429 : 200 },
      );
    }

    if (result.order_id) {
      await notifyLowStockAfterSale(result.order_id).catch(() => null);
    }

    return NextResponse.json({
      ok: true,
      orderId: result.order_id,
      orderNumber: result.order_number,
      committedLines: result.committed_lines,
    });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
