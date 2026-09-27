import { NextRequest, NextResponse } from 'next/server';
import { redeemPickupCode } from '@/lib/commerce.server';
import { checkKioskAccess, maskPickupCode, PICKUP_FAILURE_COPY } from '@/lib/kiosk.server';
import { notifyLowStockAfterSale } from '@/lib/notifications.server';

/**
 * POST /api/kiosk/pickup — valida el PIN y ENTREGA el pedido.
 *
 * Body: `{ code: string }`  ← los 6 dígitos que el cliente le dicta a la operaria.
 *
 * Este endpoint es el que consolida el inventario: `redeemPickupCode()` canjea el PIN,
 * pasa el pedido a `picked_up` y convierte la reserva en salida real de stock, todo en
 * una transacción. Si algo falla, no queda ni PIN consumido ni stock mal contado.
 *
 * ─── CÓDIGOS HTTP ────────────────────────────────────────────────────────────
 * Un PIN que no sirve es un RESULTADO del negocio, no un error de transporte: por eso
 * viaja en 200 con `{ ok: false, code, error }` y la pantalla muestra `error` tal cual.
 * El 429 sí se separa porque además hay que dejar de aceptar intentos.
 *
 * 200 ok o PIN inválido · 400 body mal formado · 401 clave de dispositivo incorrecta
 * 429 demasiados intentos · 500 fallo inesperado · 503 sin configurar
 */
export async function POST(request: NextRequest) {
  const access = checkKioskAccess(request);
  if (!access.ok) {
    return NextResponse.json({ ok: false, code: access.code, error: access.message }, { status: access.status });
  }

  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'Solicitud inválida.' },
      { status: 400 },
    );
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';

  // Validación barata: el teclado ya limita a 6 dígitos, y esto evita mandar basura a
  // la base. Además hace imposible que un PIN con letras consuma intentos del freno.
  if (!/^[0-9]{6}$/.test(code)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_code_format', error: 'El PIN son 6 números.' },
      { status: 400 },
    );
  }

  try {
    const result = await redeemPickupCode({
      code,
      redeemedBy: access.actor,
      deviceId: access.deviceId,
      ip: access.ip,
    });

    if (!result.ok) {
      const failureCode = result.error_code ?? 'pickup_code_not_found';
      const throttled = failureCode === 'pickup_rate_limited';

      console.warn('[kiosk] PIN rechazado', {
        code: maskPickupCode(code),
        reason: failureCode,
        device: access.deviceId,
      });

      return NextResponse.json(
        {
          ok: false,
          code: failureCode,
          error: PICKUP_FAILURE_COPY[failureCode] ?? 'No se pudo validar el PIN. Llama al supervisor.',
        },
        { status: throttled ? 429 : 200 },
      );
    }

    console.info('[kiosk] entrega registrada', {
      orderNumber: result.order_number,
      committedLines: result.committed_lines,
      device: access.deviceId,
    });

    // `committedLines` es la prueba de que el inventario se descontó de verdad. Si
    // llegara en 0 con `ok: true`, algo se saltó el commit de stock y hay que saberlo.
    if (result.committed_lines <= 0) {
      console.error('[kiosk] entrega sin líneas descontadas de inventario', {
        orderNumber: result.order_number,
        orderId: result.order_id,
      });
    } else if (result.order_id) {
      // Alerta de stock bajo (best-effort): la venta ya se consolidó, así que un
      // correo caído no puede afectar la entrega.
      const lowStock = await notifyLowStockAfterSale(result.order_id);
      if (lowStock.status === 'sent') {
        console.warn('[kiosk] alerta de stock bajo enviada', {
          orderNumber: result.order_number,
          skus: lowStock.count,
        });
      }
    }

    return NextResponse.json(
      {
        ok: true,
        orderId: result.order_id,
        orderNumber: result.order_number,
        lockerCode: result.locker_code,
        lockerSlot: result.locker_slot,
        committedLines: result.committed_lines,
      },
      { status: 200 },
    );
  } catch (error) {
    // Típicamente `insufficient_stock`: la reserva ya no estaba, así que el commit de
    // stock revirtió TODO — el PIN sigue siendo válido y el pedido sigue listo.
    console.error('[kiosk] fallo al registrar la entrega', { code: maskPickupCode(code), error });

    return NextResponse.json(
      {
        ok: false,
        code: 'pickup_failed',
        error: 'No se pudo registrar la entrega. No entregues el pedido y llama al supervisor.',
      },
      { status: 500 },
    );
  }
}
