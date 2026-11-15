/**
 * POST /api/merchant/stores/:storeId/orders/:orderId/ready
 *
 * El comerciante marca el pedido como listo desde SU panel, sin depender del
 * kiosco. Usa el mismo motor (`mark_order_ready_for_pickup`) que la tablet:
 * pasa por `preparing`, emite el PIN y avisa al comprador por correo.
 *
 * Seguridad: `requireStoreAccess` + verificación de que el pedido pertenece a
 * la tienda. El PIN NUNCA se devuelve al panel del comerciante.
 */

import { NextResponse } from 'next/server';
import { classifyCommerceError } from '@/lib/commerce';
import { isCommerceDbConfigured, markReadyForPickup } from '@/lib/commerce.server';
import { getSessionUser } from '@/lib/auth.server';
import { notifyPickupReadySafely } from '@/lib/notifications.server';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { requireStoreAccess } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const gate = await rateLimitGate(request, 'merchant-order-ready', {
    limit: 30,
    windowMs: 60_000,
    key: `order-ready:${user.id}`,
  });
  if (gate) return gate;

  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { error: 'La base de datos no está configurada.', code: 'db_not_configured' },
      { status: 503 },
    );
  }

  try {
    await requireStoreAccess(user.id, storeId, 'admin');

    const sql = requirePlatformSql();
    const rows = (await sql`
      SELECT id FROM orders
       WHERE id = ${orderId}::uuid AND store_id = ${storeId}::uuid
       LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) {
      return NextResponse.json(
        { error: 'Pedido no encontrado.', code: 'order_not_found' },
        { status: 404 },
      );
    }

    const pickupCode = await markReadyForPickup(orderId, {
      actor: `merchant:${user.id}`,
    });

    const notification = await notifyPickupReadySafely(orderId, pickupCode);

    return NextResponse.json({
      ok: true,
      orderId,
      codeExpiresAt: pickupCode.expiresAt,
      customerNotification: notification.status,
    });
  } catch (error) {
    const code = classifyCommerceError(error);
    if (
      code === 'invalid_order_transition' ||
      code === 'order_not_paid' ||
      code === 'order_requires_review'
    ) {
      return NextResponse.json(
        {
          error:
            code === 'order_not_paid'
              ? 'Primero confirma el pago del pedido.'
              : code === 'order_requires_review'
                ? 'El pedido está en revisión por un problema de stock. No lo prepares todavía.'
                : 'Este pedido no se puede marcar como listo en su estado actual.',
          code,
        },
        { status: 409 },
      );
    }
    return platformErrorResponse(error);
  }
}
