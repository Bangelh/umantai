/**
 * POST /api/merchant/stores/:storeId/orders/:orderId/payment
 *
 *   { action: 'approve' | 'reject', note?: string }
 *
 * La tienda revisa la captura que subió el comprador:
 *
 *   approve → confirma el pago con el MISMO motor que usaba la pasarela
 *             (`confirm_order_payment`). Re-reserva stock si la reserva se había
 *             liberado y deja el pedido `confirmed`. No hay un segundo camino de
 *             confirmación que pueda desincronizar el inventario.
 *   reject  → marca el comprobante como rechazado, cancela el pedido y libera
 *             el stock. Si la tienda dice que no pagó, los artículos vuelven a
 *             estar disponibles para otros compradores.
 *
 * `requireStoreAccess` + `store_id` en el SELECT: un pedido de otra tienda es
 * 404 aunque se conozca el UUID.
 */

import { NextResponse } from 'next/server';
import { classifyCommerceError } from '@/lib/commerce';
import { confirmOrderPayment } from '@/lib/commerce.server';
import { getSessionUser } from '@/lib/auth.server';
import { logEvent } from '@/lib/observability.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { requireStoreAccess } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string; orderId: string }>;
}

interface Body {
  action?: unknown;
  note?: unknown;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const gate = await rateLimitGate(request, 'merchant-payment-review', {
    limit: 20,
    windowMs: 60_000,
    key: `payment-review:${user.id}`,
  });
  if (gate) return gate;

  const { storeId, orderId } = await context.params;
  try {
    await requireStoreAccess(user.id, storeId, 'admin');

    const body = await readJsonBody<Body>(request);
    const action = body?.action;
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json(
        { error: 'action debe ser approve o reject.', code: 'invalid_action' },
        { status: 400 },
      );
    }

    const note =
      typeof body?.note === 'string' ? body.note.trim().slice(0, 280) || null : null;

    const sql = requirePlatformSql();
    const rows = (await sql`
      SELECT id, order_number, status, total, currency, metadata
        FROM orders
       WHERE id = ${orderId}::uuid
         AND store_id = ${storeId}::uuid
       LIMIT 1
    `) as Array<Record<string, unknown>>;

    const row = rows[0];
    if (!row) {
      return NextResponse.json(
        { error: 'Pedido no encontrado.', code: 'order_not_found' },
        { status: 404 },
      );
    }

    if (row.status !== 'pending_payment') {
      return NextResponse.json(
        { error: 'Este pedido ya no espera pago.', code: 'order_not_payable' },
        { status: 409 },
      );
    }

    if (action === 'reject') {
      // El UPDATE y la liberación van en la misma sentencia: si otra revisión ya
      // cambió el pedido, el CTE no devuelve filas y NO se libera stock ajeno.
      const released = (await sql`
        WITH cancelled AS (
          UPDATE orders
             SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'paymentProof', COALESCE(metadata -> 'paymentProof', '{}'::jsonb)
                     || jsonb_build_object(
                          'status', 'rejected',
                          'note', ${note}::text,
                          'reviewedAt', to_jsonb(NOW())
                        )
                 ),
                 status = 'cancelled',
                 cancelled_reason = 'payment_proof_rejected',
                 reservation_expires_at = NULL,
                 reservation_released = TRUE,
                 updated_at = NOW()
           WHERE id = ${orderId}::uuid
             AND store_id = ${storeId}::uuid
             AND status = 'pending_payment'
           RETURNING id
        )
        SELECT id, inventory_release_order(id, 'payment_proof_rejected') AS lines_released
          FROM cancelled
      `) as Array<Record<string, unknown>>;

      if (!released[0]) {
        return NextResponse.json(
          { error: 'Este pedido ya no espera pago.', code: 'order_not_payable' },
          { status: 409 },
        );
      }

      logEvent('order_payment_proof_rejected', {
        storeId,
        orderId,
        userId: user.id,
        linesReleased: Number(released[0].lines_released ?? 0),
      });

      return NextResponse.json({
        ok: true,
        status: 'rejected',
        orderStatus: 'cancelled',
        linesReleased: Number(released[0].lines_released ?? 0),
      });
    }

    const confirmed = await confirmOrderPayment({
      orderNumber: String(row.order_number),
      // Id estable por pedido: reintentar aprobar no crea un segundo cobro.
      paymentId: `proof-${orderId}`,
      paymentMethod: 'manual_transfer',
      paidAmount: Number(row.total),
      currency: String(row.currency ?? 'PEN'),
      paymentMetadata: {
        source: 'store_review',
        storeId,
        reviewedBy: user.id,
        note,
      },
      actor: `merchant:${user.id}`,
    });

    await sql`
      UPDATE orders
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'paymentProof', COALESCE(metadata -> 'paymentProof', '{}'::jsonb)
                 || jsonb_build_object(
                      'status', 'approved',
                      'note', ${note}::text,
                      'reviewedAt', to_jsonb(NOW())
                    )
             ),
             updated_at = NOW()
       WHERE id = ${orderId}::uuid
         AND store_id = ${storeId}::uuid
    `;

    logEvent('order_payment_proof_approved', {
      storeId,
      orderId,
      userId: user.id,
    });

    return NextResponse.json({
      ok: true,
      order: confirmed
        ? { status: confirmed.status, paymentStatus: confirmed.paymentStatus }
        : null,
    });
  } catch (error) {
    const code = classifyCommerceError(error);
    if (code) {
      return NextResponse.json({ error: code, code }, { status: 409 });
    }
    return platformErrorResponse(error);
  }
}
