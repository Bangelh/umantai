import { NextResponse } from 'next/server';
import {
  DEFAULT_QA_PAYER_EMAIL,
  QA_EXTERNAL_REFERENCE_PREFIX,
  MpOrdersApiError,
  MpOrdersValidationError,
  buildMpOrdersCreateBody,
  createMpOrdersOrder,
  getMpOrdersAccessToken,
  getMpOrdersBackUrlBase,
  isMpOrdersConfigured,
  type MpOrdersItemInput,
} from '@/lib/mercadopago-orders.server';

/**
 * POST /api/mp-orders/create — orden QA de la integración CLEAN-ROOM.
 *
 * Crea UNA orden mínima contra `POST https://api.mercadopago.com/v1/orders`
 * (Checkout Pro, `type=online`, `processing_mode=manual`) y devuelve la
 * `checkout_url`. NO toca las tablas de UMANTAI: ni `orders`, ni `inventory`, ni
 * `inventory_movements`, ni `pickup`. Es un experimento aislado.
 *
 * ─── QUÉ NO HACE ────────────────────────────────────────────────────────────
 *  · NO reutiliza el access token ni ningún helper de la integración vieja
 *    (`lib/mercadopago.server.ts`): lee únicamente las variables `MP_ORDERS_*`.
 *  · NO envía `notification_url`: la Orders API no lo acepta; el webhook del
 *    tópico `order` se configura a nivel de aplicación en Mercado Pago.
 *  · NO confirma pedidos ni escribe en la base.
 *
 * ─── CREDENCIALES ───────────────────────────────────────────────────────────
 *  El access token viaja SOLO en la cabecera `Authorization` hacia MP. La respuesta
 *  contiene exclusivamente `orderId`, `status`, `checkoutUrl`, `externalReference` y
 *  `totalAmount`; nunca el token ni cabeceras de autorización.
 *
 * Body opcional (JSON, todos los campos opcionales):
 *   · `payerEmail` — email del comprador. Por defecto `qa.mp.orders@testuser.com`
 *     porque la doc exige `@testuser.com` en sandbox (`invalid_email_for_sandbox`).
 *   · `totalAmount` — monto de la orden en formato decimal. Por defecto `"1.00"`.
 *   · `externalReference` — referencia externa (máx. 64 caracteres). Por defecto
 *     `UMANTAI-MP-ORDERS-QA-<uuid>`, única por creación.
 *
 * Respuestas: 201 creada · 400 body inválido · 503 sin `MP_ORDERS_ACCESS_TOKEN`
 * (fail-closed) · 502 si MP rechaza o no responde.
 */

/** Monto por defecto de la orden QA (PEN). La doc no fija un mínimo para Checkout Pro. */
const QA_TOTAL_AMOUNT = '1.00';

/** Título del ítem QA. */
const QA_ITEM_TITLE = 'UMANTAI MP Orders QA';

function log(event: string, details: Record<string, unknown>) {
  console.info(`[mp-orders-create] ${event}`, details);
}

export async function POST(request: Request) {
  if (!isMpOrdersConfigured()) {
    // Fail-closed: sin token propio no se intenta nada (y NO se cae al legacy).
    return NextResponse.json(
      {
        ok: false,
        code: 'mp_orders_not_configured',
        error: 'Falta MP_ORDERS_ACCESS_TOKEN en el entorno del servidor.',
      },
      { status: 503 },
    );
  }

  let payload: Record<string, unknown> = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        return NextResponse.json(
          { ok: false, code: 'invalid_body', error: 'El body debe ser un objeto JSON.' },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        { ok: false, code: 'invalid_body', error: 'El body no es JSON válido.' },
        { status: 400 },
      );
    }
  }

  const payerEmail =
    typeof payload.payerEmail === 'string' ? payload.payerEmail : DEFAULT_QA_PAYER_EMAIL;
  const totalAmount =
    typeof payload.totalAmount === 'string' ? payload.totalAmount : QA_TOTAL_AMOUNT;
  const externalReference =
    typeof payload.externalReference === 'string' && payload.externalReference.trim()
      ? payload.externalReference
      : `${QA_EXTERNAL_REFERENCE_PREFIX}${crypto.randomUUID()}`;

  const items: MpOrdersItemInput[] = [
    { title: QA_ITEM_TITLE, unitPrice: totalAmount, quantity: 1 },
  ];

  let body;
  try {
    body = buildMpOrdersCreateBody({
      externalReference,
      payerEmail,
      items,
      backUrlBase: getMpOrdersBackUrlBase(),
    });
  } catch (error) {
    if (error instanceof MpOrdersValidationError) {
      return NextResponse.json(
        { ok: false, code: error.message, error: 'Parámetros de la orden inválidos.' },
        { status: 400 },
      );
    }
    throw error;
  }

  // UUID nuevo por intento: la doc exige un `X-Idempotency-Key` único y MP rechaza
  // reutilizarlo (`idempotency_key_already_used`).
  const idempotencyKey = crypto.randomUUID();

  try {
    const order = await createMpOrdersOrder({
      body,
      idempotencyKey,
      accessToken: getMpOrdersAccessToken(),
    });

    log('created', {
      orderId: order.orderId,
      status: order.status,
      externalReference: order.externalReference,
      totalAmount: order.totalAmount,
      processingMode: body.processing_mode,
      backUrlsConfigured: Boolean(body.config),
    });

    return NextResponse.json(
      {
        orderId: order.orderId,
        status: order.status,
        checkoutUrl: order.checkoutUrl,
        externalReference: order.externalReference,
        totalAmount: order.totalAmount,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof MpOrdersApiError) {
      // Se registra SOLO el código y el mensaje acotado de MP; nunca el token.
      console.error('[mp-orders-create] mercadopago rejected the order', {
        httpStatus: error.httpStatus,
        mpCode: error.mpCode,
        detail: error.message,
      });
      return NextResponse.json(
        { ok: false, code: error.mpCode ?? 'mp_orders_api_error', error: 'Mercado Pago rechazó la orden.' },
        { status: 502 },
      );
    }
    console.error('[mp-orders-create] unexpected failure', error);
    return NextResponse.json(
      { ok: false, code: 'mp_orders_unexpected_error', error: 'No se pudo crear la orden.' },
      { status: 500 },
    );
  }
}
