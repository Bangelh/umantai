import { NextResponse } from 'next/server';
import {
  MpOrdersApiError,
  fetchMpOrdersOrder,
  getMpOrdersAccessToken,
  getMpOrdersWebhookSecret,
  isMpOrdersConfigured,
  isMpOrdersWebhookConfigured,
  verifyMpOrdersWebhookSignature,
} from '@/lib/mercadopago-orders.server';

/**
 * POST /api/mp-orders/webhook — receptor CLEAN-ROOM del tópico `order`.
 *
 * Ruta NUEVA, independiente de `/api/payments/webhook`. No importa ni reutiliza
 * helpers, secretos ni tokens de la integración antigua basada en Preferences.
 *
 * ─── QUÉ MANDA MERCADO PAGO (doc oficial, tópico `order`) ───────────────────
 *   POST /<nuestra-url>?data.id=ORD01JQ4S4KY8HWQ6NA5PXB65B3D3&type=order
 *   X-Request-Id: 2066ca19-...
 *   X-Signature: ts=1742505638683,v1=<hmac>
 *   body: { action: "order.processed", type: "order", data: { id: "ORD..." }, ... }
 *
 * El `data.id` llega en el QUERY STRING (no en el body) y ES un id de Order. La
 * documentación del tópico usa `data.id` — a diferencia del flujo viejo de pagos,
 * donde además aparecía un `id` suelto. Por eso acá NO se acepta el fallback `id`:
 * la forma verificada en la doc es `data.id` y cualquier otra cosa falla cerrado.
 *
 * ─── REGLAS ─────────────────────────────────────────────────────────────────
 *   · Sin `MP_ORDERS_WEBHOOK_SECRET` → 503 (no hay forma de autenticar; MP reintenta).
 *   · Faltan `x-signature`, `x-request-id` o `data.id` → 401 (fail-closed).
 *   · Firma inválida → 401 (MP reintenta, útil si el secret se cargó mal).
 *   · Firma válida → se consulta la Order y se responde 200.
 *   · NUNCA se confía en el body para autenticar: el body solo aporta `action`/`type`
 *     para diagnóstico, y los datos reales se leen de la API con nuestro token.
 *
 * ─── SIN EFECTOS SECUNDARIOS ────────────────────────────────────────────────
 *  Esta ruta NO escribe en `orders`, `inventory`, `inventory_movements`, `pickup` ni
 *  dispara correos. Solo valida, consulta y registra.
 */

/** Tópico que nos interesa. Cualquier otro se acusa recibo y se ignora. */
const ORDER_TOPIC = 'order';

/** Se registra SOLO presencia/longitud; nunca el valor de `x-signature` ni del hash. */
function summarizeSignatureHeader(raw: string | null): {
  present: boolean;
  ts: string | null;
  v1Length: number | null;
} {
  if (!raw) return { present: false, ts: null, v1Length: null };
  let ts: string | null = null;
  let v1Length: number | null = null;
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1Length = value.length;
  }
  return { present: true, ts, v1Length };
}

function log(event: string, details: Record<string, unknown>) {
  console.info(`[mp-orders-webhook] ${event}`, details);
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  const url = new URL(request.url);

  const xSignature = request.headers.get('x-signature');
  const xRequestId = request.headers.get('x-request-id');
  // Doc verificada: el tópico `order` manda el id del recurso en `data.id`.
  const dataId = url.searchParams.get('data.id');
  const queryType = url.searchParams.get('type') ?? url.searchParams.get('topic');

  const rawBody = await request.text();
  let body: Record<string, unknown> = {};
  if (rawBody) {
    try {
      body = asRecord(JSON.parse(rawBody)) ?? {};
    } catch {
      // Un cuerpo no-JSON no impide validar: la firma se calcula sobre el query string.
    }
  }

  const bodyType = firstString(body.type) ?? firstString(body.topic);
  const action = firstString(body.action);
  const notificationType = queryType ?? bodyType;
  const signature = summarizeSignatureHeader(xSignature);

  // ─── Observabilidad (sin secretos) ──────────────────────────────────────────
  log('received', {
    receivedAt,
    userAgent: request.headers.get('user-agent'),
    type: notificationType,
    action,
    dataId,
    xRequestIdPresent: Boolean(xRequestId),
    xRequestIdLength: xRequestId ? xRequestId.length : null,
    xSignaturePresent: signature.present,
    ts: signature.ts,
    v1Length: signature.v1Length,
  });

  // ─── 0. Configuración (fail-closed) ─────────────────────────────────────────
  if (!isMpOrdersWebhookConfigured()) {
    console.error('[mp-orders-webhook] MP_ORDERS_WEBHOOK_SECRET is not set: cannot verify notifications');
    return NextResponse.json(
      { ok: false, code: 'mp_orders_webhook_not_configured' },
      { status: 503 },
    );
  }

  // ─── 1. Inputs requeridos por el manifest oficial ───────────────────────────
  if (!xSignature || !xRequestId || !dataId) {
    const missing: string[] = [];
    if (!xSignature) missing.push('x-signature');
    if (!xRequestId) missing.push('x-request-id');
    if (!dataId) missing.push('data.id');
    log('rejected-missing-inputs', { missing, type: notificationType });
    return NextResponse.json(
      { ok: false, code: 'missing_signature_inputs', missing },
      { status: 401 },
    );
  }

  // ─── 2. Firma (validador OFICIAL del SDK) ───────────────────────────────────
  const check = verifyMpOrdersWebhookSignature({
    xSignature,
    xRequestId,
    dataId,
    secret: getMpOrdersWebhookSecret(),
  });

  if (!check.ok) {
    console.error('[mp-orders-webhook] invalid signature', {
      reason: check.reason,
      requestId: check.requestId ?? xRequestId,
      timestamp: check.timestamp,
      type: notificationType,
      dataId,
    });
    return NextResponse.json({ ok: false, code: 'invalid_signature', reason: check.reason }, { status: 401 });
  }

  log('signature-ok', { type: notificationType, dataId });

  // ─── 3. Solo el tópico `order` nos interesa ─────────────────────────────────
  if (notificationType && notificationType !== ORDER_TOPIC) {
    log('ignored-topic', { type: notificationType, dataId });
    return NextResponse.json({ ok: true, received: true, ignored: notificationType }, { status: 200 });
  }

  // ─── 4. Sin access token no se puede leer la Order ──────────────────────────
  if (!isMpOrdersConfigured()) {
    console.error('[mp-orders-webhook] MP_ORDERS_ACCESS_TOKEN is not set: cannot read the order');
    return NextResponse.json({ ok: false, code: 'mp_orders_not_configured' }, { status: 503 });
  }

  // ─── 5. Consultar la ORDER (no el Payment) con nuestro token ────────────────
  let order;
  try {
    order = await fetchMpOrdersOrder({ orderId: dataId, accessToken: getMpOrdersAccessToken() });
  } catch (error) {
    if (error instanceof MpOrdersApiError) {
      console.error('[mp-orders-webhook] could not read the order from Mercado Pago', {
        orderId: dataId,
        httpStatus: error.httpStatus,
        mpCode: error.mpCode,
      });
    } else {
      console.error('[mp-orders-webhook] unexpected failure reading the order', { orderId: dataId });
    }
    // 500 para que Mercado Pago reintente el aviso.
    return NextResponse.json({ ok: false, code: 'order_read_failed' }, { status: 500 });
  }

  log('order-read', {
    orderId: order.orderId,
    externalReference: order.externalReference,
    orderStatus: order.status,
    orderStatusDetail: order.statusDetail,
    processingMode: order.processingMode,
    totalAmount: order.totalAmount,
    totalPaidAmount: order.totalPaidAmount,
    payerEmail: order.payerEmailPresent ? 'PRESENT' : 'ABSENT',
    paymentStatus: order.paymentStatus,
    applicationId: order.applicationId,
    collectorId: order.collectorId,
  });

  // Sin efectos secundarios: no se confirma ningún pedido de UMANTAI.
  return NextResponse.json(
    {
      ok: true,
      received: true,
      orderId: order.orderId,
      status: order.status,
      externalReference: order.externalReference,
    },
    { status: 200 },
  );
}
