/**
 * POST /api/orders/:token/proof — el comprador sube la captura de su pago.
 *
 * El `token` es el `public_token` del pedido, el mismo del enlace que el
 * comprador ya tiene. Solo se acepta mientras el pedido siga `pending_payment` y
 * su reserva esté viva: subir un comprobante a un pedido vencido no reserva
 * nada y confundiría a la tienda.
 *
 * La imagen pasa por el mismo almacenamiento que los logos (`media_assets`), con
 * el scope de banner de la tienda: la restricción vigente de `media_assets` no
 * tiene un scope propio para comprobantes y no vale la pena migrarla solo por
 * una etiqueta. La captura pertenece a la tienda y se sirve por `/api/media`,
 * igual que su logo.
 */

import { NextResponse, after } from 'next/server';
import { evaluateOrderPayability } from '@/lib/commerce';
import { getOrderByPublicToken } from '@/lib/commerce.server';
import { platformErrorResponse } from '@/lib/platform-api.server';
import { requirePlatformSql } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { putImage } from '@/lib/storage.server';
import { notifyPaymentProofSafely } from '@/lib/notifications.server';
import { notifyStorePaymentProofSafely } from '@/lib/whatsapp.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!UUID_PATTERN.test(token)) {
    return NextResponse.json(
      { error: 'Enlace de pedido inválido.', code: 'invalid_token' },
      { status: 400 },
    );
  }

  const gate = await rateLimitGate(request, 'order-payment-proof', {
    limit: 6,
    windowMs: 60_000,
    key: `payment-proof:${token}`,
  });
  if (gate) return gate;

  let order;
  try {
    order = await getOrderByPublicToken(token);
  } catch (error) {
    console.error('POST /api/orders/[token]/proof: no se pudo leer el pedido', error);
    return NextResponse.json(
      { error: 'No se pudo cargar el pedido.', code: 'order_load_failed' },
      { status: 500 },
    );
  }

  if (!order) {
    return NextResponse.json(
      { error: 'Pedido no encontrado.', code: 'order_not_found' },
      { status: 404 },
    );
  }

  if (order.status !== 'pending_payment') {
    return NextResponse.json(
      { error: 'Este pedido ya no espera pago.', code: 'order_not_payable' },
      { status: 409 },
    );
  }

  if (evaluateOrderPayability(order) !== 'payable') {
    return NextResponse.json(
      {
        error: 'La reserva de stock venció. Vuelve a hacer el pedido.',
        code: 'reservation_expired',
      },
      { status: 409 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'Falta la captura del pago.', code: 'media_missing' },
      { status: 400 },
    );
  }

  try {
    const sql = requirePlatformSql();
    const storeRows = (await sql`
      SELECT store_id FROM orders WHERE id = ${order.id}::uuid LIMIT 1
    `) as Array<Record<string, unknown>>;
    const storeId = storeRows[0] ? String(storeRows[0].store_id) : null;
    if (!storeId) {
      return NextResponse.json(
        { error: 'Pedido sin tienda.', code: 'store_not_found' },
        { status: 404 },
      );
    }

    const media = await putImage({
      scope: 'store_banner',
      file,
      userId: null,
      storeId,
    });

    // La reserva deja de correr cuando el comprobante ya está en manos de la
    // tienda: el comprador pagó y el pedido espera revisión, no el contador.
    const updated = (await sql`
      UPDATE orders
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'paymentProof', jsonb_build_object(
                 'url', ${media.url}::text,
                 'uploadedAt', to_jsonb(NOW()),
                 'status', 'submitted'
               )
             ),
             reservation_expires_at = NULL,
             updated_at = NOW()
       WHERE id = ${order.id}::uuid
         AND status = 'pending_payment'
      RETURNING id
    `) as Array<Record<string, unknown>>;

    if (!updated[0]) {
      return NextResponse.json(
        { error: 'Este pedido ya no espera pago.', code: 'order_not_payable' },
        { status: 409 },
      );
    }

    // Avisar a la tienda por correo y WhatsApp. La captura ya está guardada: si
    // un aviso falla, el comprador puede reintentar sin perder nada.
    after(async () => {
      await Promise.allSettled([
        notifyPaymentProofSafely(order.id),
        notifyStorePaymentProofSafely(order.id),
      ]);
    });

    return NextResponse.json({ ok: true, proofUrl: media.url }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
