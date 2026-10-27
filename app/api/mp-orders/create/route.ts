import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { isProductionRuntime } from '@/lib/runtime-environment.server';
import {
  DEFAULT_MP_ORDERS_ITEM_PAYLOAD_MODE,
  MP_ORDERS_QA_PAYER_EMAIL_ENV,
  MpOrdersApiError,
  MpOrdersValidationError,
  QA_EXTERNAL_REFERENCE_PREFIX,
  buildMpOrdersCreateBody,
  createMpOrdersOrder,
  getMpOrdersAccessToken,
  getMpOrdersBackUrlBase,
  getMpOrdersQaPayerEmail,
  isMpOrdersConfigured,
  isMpOrdersQaPayerEmailConfigured,
  type MpOrdersItemInput,
  type MpOrdersItemPayloadMode,
} from '@/lib/mercadopago-orders.server';

/**
 * POST /api/mp-orders/create — orden QA de la integración CLEAN-ROOM.
 *
 * Crea UNA orden mínima contra `POST https://api.mercadopago.com/v1/orders`
 * (Checkout Pro, `type=online`, `processing_mode=manual`) y devuelve la
 * `checkout_url`. NO toca las tablas de UMANTAI: ni `orders`, ni `inventory`, ni
 * `inventory_movements`, ni `pickup`. Es un experimento aislado.
 *
 * ─── CANDADOS (los cuatro, en orden, sin fallback) ───────────────────────────
 *   1. Entorno NO productivo (fail-closed por `lib/runtime-environment.server.ts`).
 *   2. Autenticación administrativa (`x-admin-token`).
 *   3. `MP_ORDERS_ACCESS_TOKEN` configurado.
 *   4. `MP_ORDERS_QA_PAYER_EMAIL` configurado (el comprador QA REAL).
 *
 * Si el entorno es Producción → 404 (la ruta "no existe" ahí; no se revela nada más).
 * Si falta o es inválido el token admin → 503/401. Si falta el access token → 503.
 * Si falta el email del comprador QA → 503 `mp_orders_qa_payer_email_missing`.
 *
 * ─── QUIÉN ELIGE AL COMPRADOR ───────────────────────────────────────────────
 *  NADIE del cliente. El `payer.email` sale SIEMPRE de `MP_ORDERS_QA_PAYER_EMAIL`
 *  (la cuenta de prueba comprador que exige la doc de Checkout Pro). Enviarlo en el
 *  body devuelve 400 `payer_email_from_body_not_allowed`: no hay forma accidental de
 *  crear una orden con un comprador elegido por el llamador.
 *
 * ─── MODO DE PAYLOAD (diagnóstico controlado) ───────────────────────────────
 *  `payloadMode` (opcional, interno): `minimal` (por defecto, el payload que ya creó
 *  órdenes) o `documented` (añade `unit_measure`/`total_amount` por ítem, como la guía
 *  oficial). Sirve para atribuir el `unsupported_properties` histórico comparando la
 *  MISMA respuesta de Mercado Pago. No se acepta ningún otro valor.
 *
 * Body opcional (JSON): `totalAmount`, `externalReference`, `payloadMode`.
 * Respuestas: 201 creada · 400 body/parámetros inválidos · 401/503 sin admin auth
 * · 404 fuera de entorno no productivo · 503 sin access token o sin comprador QA
 * · 502 si Mercado Pago rechaza o no responde · 500 fallo inesperado.
 */

/** Monto por defecto de la orden QA (PEN). La doc no fija un mínimo para Checkout Pro. */
const QA_TOTAL_AMOUNT = '1.00';

/** Título del ítem QA. */
const QA_ITEM_TITLE = 'UMANTAI MP Orders QA';

/** Modos aceptados (lista cerrada: nada fuera de esto llega al payload). */
const PAYLOAD_MODES: readonly MpOrdersItemPayloadMode[] = ['minimal', 'documented'];

function log(event: string, details: Record<string, unknown>) {
  console.info(`[mp-orders-create] ${event}`, details);
}

export async function POST(request: Request) {
  // ─── 1. Entorno (fail-closed, decisión centralizada) ────────────────────────
  if (isProductionRuntime()) {
    return NextResponse.json(
      { ok: false, code: 'mp_orders_create_unavailable', error: 'No disponible.' },
      { status: 404 },
    );
  }

  // ─── 2. Autenticación administrativa ────────────────────────────────────────
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, code: access.code, error: access.message },
      { status: access.status },
    );
  }

  // ─── 3. Access token propio (NUNCA se cae al flujo legacy) ──────────────────
  if (!isMpOrdersConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: 'mp_orders_not_configured',
        error: 'Falta MP_ORDERS_ACCESS_TOKEN en el entorno del servidor.',
      },
      { status: 503 },
    );
  }

  // ─── 4. Comprador QA real ───────────────────────────────────────────────────
  if (!isMpOrdersQaPayerEmailConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: 'mp_orders_qa_payer_email_missing',
        error: `Falta ${MP_ORDERS_QA_PAYER_EMAIL_ENV} en el entorno del servidor.`,
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

  // El comprador NO se negocia: si el llamador lo intenta, se rechaza explícitamente
  // en vez de ignorarlo (un default silencioso es justo el error que estamos cerrando).
  if (payload.payerEmail !== undefined) {
    return NextResponse.json(
      {
        ok: false,
        code: 'payer_email_from_body_not_allowed',
        error: `El comprador lo define el servidor (${MP_ORDERS_QA_PAYER_EMAIL_ENV}).`,
      },
      { status: 400 },
    );
  }

  const requestedPayloadMode = payload.payloadMode;
  if (
    requestedPayloadMode !== undefined &&
    (typeof requestedPayloadMode !== 'string' ||
      !PAYLOAD_MODES.includes(requestedPayloadMode as MpOrdersItemPayloadMode))
  ) {
    return NextResponse.json(
      { ok: false, code: 'invalid_payload_mode', error: 'payloadMode debe ser minimal o documented.' },
      { status: 400 },
    );
  }
  const payloadMode =
    (requestedPayloadMode as MpOrdersItemPayloadMode | undefined) ??
    DEFAULT_MP_ORDERS_ITEM_PAYLOAD_MODE;

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
      // Único origen posible del comprador: el entorno del servidor.
      payerEmail: getMpOrdersQaPayerEmail(),
      items,
      backUrlBase: getMpOrdersBackUrlBase(),
      payloadMode,
    });
  } catch (error) {
    if (error instanceof MpOrdersValidationError) {
      return NextResponse.json(
        { ok: false, code: error.message, error: 'Parámetros de la orden inválidos.' },
        { status: error.message === 'mp_orders_qa_payer_email_missing' ? 503 : 400 },
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

    // NUNCA se loguea el email del comprador: solo de dónde salió (`env`).
    log('created', {
      orderId: order.orderId,
      status: order.status,
      externalReference: order.externalReference,
      totalAmount: order.totalAmount,
      processingMode: body.processing_mode,
      itemsPayloadMode: payloadMode,
      payerSource: 'env',
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
      // Se registran SOLO campos acotados y sanitizados de MP: código, detalle,
      // propiedad ofensora, `x-request-id` de MP y el resumen de `details` (que es
      // donde `unsupported_properties` nombra la propiedad no soportada). Nunca el
      // token, ni cabeceras, ni el cuerpo completo (todo viene redactado y acotado
      // por la librería). Se añade el modo de payload para poder comparar intentos.
      console.error('[mp-orders-create] mercadopago rejected the order', {
        httpStatus: error.httpStatus,
        mpCode: error.mpCode,
        detail: error.message,
        field: error.field,
        mpRequestId: error.mpRequestId,
        mpDetails: error.mpDetails,
        itemsPayloadMode: payloadMode,
        backUrlsConfigured: Boolean(body.config),
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
