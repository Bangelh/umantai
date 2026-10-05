import { NextRequest, NextResponse } from 'next/server';
import { classifyCommerceError } from '@/lib/commerce';
import { isCommerceDbConfigured, markReadyForPickup } from '@/lib/commerce.server';
import { checkKioskAccess, READY_FAILURE_COPY } from '@/lib/kiosk.server';
import { notifyPickupReadySafely } from '@/lib/notifications.server';

/**
 * POST /api/kiosk/ready — la operaria marca un pedido como listo y se emite su PIN.
 *
 * Body: `{ orderId: string, lockerCode?: string, lockerSlot?: string }`
 *
 * La base hace en una transacción el salto `confirmed → preparing → ready_for_pickup`
 * y emite el PIN (`mark_order_ready_for_pickup`, migración 003). El paso por
 * `preparing` no es opcional: la máquina de estados no permite
 * `confirmed → ready_for_pickup`, así que el trigger rechazaría el cambio directo.
 *
 * ─── NUNCA DEVUELVE EL PIN ───────────────────────────────────────────────────
 * El PIN lo recibe el cliente, no la pantalla de la operaria: es ella quien lo tipea
 * después y el control tiene que probar algo. Si una operaria necesita reimprimir el
 * PIN de un cliente, eso es una acción auditada de supervisor, no un GET del kiosco.
 * El cliente lo ve en /pedido/<token> (vía `getIssuedPickupCode()`), que es su enlace.
 *
 * ─── AVISO AL CLIENTE ──────────────────────────────────────────────────
 * Además se avisa al COMPRADOR por correo (`notifyPickupReadySafely`), a la dirección
 * que dejó en el checkout. Es BEST-EFFORT: el PIN ya existe y el pedido ya está listo,
 * así que un correo que falla no puede revertir nada — sólo se informa en
 * `customerNotification` para que la pantalla pueda decir si el cliente quedó avisado.
 *
 * 200 emitido · 400 body inválido · 401 clave incorrecta
 * 409 el pedido no se puede preparar (estado o pago) · 500 fallo inesperado · 503
 */
export async function POST(request: NextRequest) {
  const access = checkKioskAccess(request);
  if (!access.ok) {
    return NextResponse.json({ ok: false, code: access.code, error: access.message }, { status: access.status });
  }

  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
      { status: 503 },
    );
  }

  let body: { orderId?: unknown; lockerCode?: unknown; lockerSlot?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, code: 'invalid_body', error: 'Solicitud inválida.' }, { status: 400 });
  }

  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  // Validación barata antes del cast ::uuid de Postgres.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_order_id', error: 'Pedido inválido. Actualiza la pantalla.' },
      { status: 400 },
    );
  }

  const lockerCode = readOptionalText(body.lockerCode);
  const lockerSlot = readOptionalText(body.lockerSlot);

  try {
    const pickupCode = await markReadyForPickup(orderId, {
      lockerCode,
      lockerSlot,
      actor: access.actor,
    });

    // Aviso al cliente: a partir de acá el pedido ya está listo, así que este paso
    // nunca puede hacer fallar la respuesta (`notifyPickupReadySafely` no lanza).
    const notification = await notifyPickupReadySafely(orderId, pickupCode);

    console.info('[kiosk] pedido marcado como listo', {
      orderId,
      lockerCode: pickupCode.lockerCode,
      lockerSlot: pickupCode.lockerSlot,
      expiresAt: pickupCode.expiresAt,
      device: access.deviceId,
      customerNotification: notification.status,
    });

    return NextResponse.json(
      {
        ok: true,
        orderId,
        lockerCode: pickupCode.lockerCode,
        lockerSlot: pickupCode.lockerSlot,
        // Se informa cuándo vence para que la pantalla pueda avisar, pero el PIN no sale.
        codeExpiresAt: pickupCode.expiresAt,
        // Sólo el estado, nunca el destinatario: la clave de dispositivo es compartida
        // y el correo del cliente no tiene por qué listarse en la tablet.
        customerNotification: notification.status,
      },
      { status: 200 },
    );
  } catch (error) {
    // La base rechaza con un código legible: `invalid_order_transition`, `order_not_paid`,
    // `order_requires_review` (conflicto de stock/revisión, migración 006).
    const engineCode = classifyCommerceError(error);

    if (
      engineCode === 'invalid_order_transition' ||
      engineCode === 'order_not_paid' ||
      engineCode === 'order_requires_review'
    ) {
      console.warn('[kiosk] no se puede preparar el pedido', { orderId, reason: engineCode });
      return NextResponse.json(
        { ok: false, code: engineCode, error: READY_FAILURE_COPY[engineCode] },
        { status: 409 },
      );
    }

    console.error('[kiosk] fallo al marcar el pedido como listo', { orderId, error });
    return NextResponse.json(
      { ok: false, code: 'ready_failed', error: 'No se pudo preparar el pedido. Llama al supervisor.' },
      { status: 500 },
    );
  }
}

/** Texto opcional saneado: sin vacíos, sin espacios sobrantes y acotado. */
function readOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 32) : null;
}
