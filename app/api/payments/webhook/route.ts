import { NextRequest, NextResponse } from 'next/server';
import { readOrderPaymentAudit } from '@/lib/commerce';
import { confirmOrderPayment, isCommerceDbConfigured } from '@/lib/commerce.server';
import {
  fetchMercadoPagoPayment,
  isMercadoPagoConfigured,
  isMercadoPagoWebhookConfigured,
  verifyMercadoPagoWebhookSignature,
} from '@/lib/mercadopago.server';
import { notifyNewOrderSafely } from '@/lib/notifications.server';

/**
 * POST /api/payments/webhook — la verdad absoluta sobre el estado de un cobro.
 *
 * Mercado Pago llama a esta URL cuando el estado de un pago cambia. Es la ÚNICA
 * forma de que un pedido pase a `confirmed`: la página de regreso
 * (`/pedido/<token>?pago=exitoso`) es sólo cosmética, y el navegador no decide nada.
 *
 * ─── QUÉ SE CONFÍA Y QUÉ NO ──────────────────────────────────────────────────
 * Un webhook es una URL pública: cualquiera puede hacerle POST y decir "ya pagué".
 *  1. La FIRMA (`x-signature`, HMAC-SHA256 con `MERCADOPAGO_WEBHOOK_SECRET`) se
 *     verifica primero. Sin firma válida no se hace NADA más.
 *  2. El cuerpo sólo aporta un ID. Nada de sus montos ni sus estados.
 *  3. El pago se relee de la API de Mercado Pago con nuestro access token, que es
 *     lo único que un atacante no puede fabricar.
 *  4. El monto y la moneda se validan contra el pedido dentro de la base
 *     (`confirm_order_payment`, migración 002).
 *
 * ─── POR QUÉ RESPONDE 200 A CASI TODO ───────────────────────────────────────
 * MP reintenta mientras no reciba un 2xx. Un aviso que no podemos procesar (tipo
 * distinto de `payment`, pago rechazado) debe terminar en 200: reintentarlo para
 * siempre no lo va a arreglar. En cambio:
 *   · 401 firma inválida  → MP reintenta (útil si el secreto estaba mal cargado)
 *   · 500 MP o base caídos → MP reintenta (acá sí queremos el reintento)
 *   · 503 sin configurar   → MP reintenta hasta que se configure
 *
 * MP corta la espera alrededor de los 22 s. Este handler hace 2 llamadas de red
 * (MP + Postgres) más el trabajo atómico; si MP tarda, devolvemos 500 y el
 * reintento posterior confirma el pedido igual (todo es idempotente).
 */

/** Ventana en la que MP considera aceptable la respuesta; documental. */
const MERCADOPAGO_RETRY_BUDGET_MS = 22_000;

function log(event: string, details: Record<string, unknown>) {
  console.info(`[mp-webhook] ${event}`, { ...details, budgetMs: MERCADOPAGO_RETRY_BUDGET_MS });
}

/**
 * ¿Estamos en un entorno de PRODUCCIÓN real?
 *
 * `NODE_ENV` NO sirve para distinguir Preview de Production en Vercel: la
 * plataforma compila y ejecuta TODOS los deployments con `NODE_ENV=production`,
 * Preview incluido. El entorno real lo dice `VERCEL_ENV`
 * (`production` | `preview` | `development`).
 *
 * Efecto: un pago de sandbox (`live_mode = false`) se ignora SOLO en Producción
 * real; en Preview y desarrollo se procesa y puede confirmar el pedido.
 *
 * Fuera de Vercel (`VERCEL_ENV` ausente) se cae a `NODE_ENV` para no abrir una
 * producción autoalojada a pagos de sandbox.
 */
function isProductionRuntime(): boolean {
  const vercelEnv = (process.env.VERCEL_ENV ?? '').trim();
  if (vercelEnv === 'production') return true;
  if (vercelEnv === 'preview' || vercelEnv === 'development') return false;
  return process.env.NODE_ENV === 'production';
}

/** Lee un valor que MP puede mandar como string, número o array (query vs body). */
function firstString(value: unknown): string | null {
  if (Array.isArray(value)) return firstString(value[0]);
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

/**
 * Id del recurso notificado.
 *
 * Se prioriza el query string porque es lo que Mercado Pago firma: la firma se
 * calcula sobre los parámetros de la URL, no sobre el cuerpo. Si se tomara el id
 * del body, una notificación legítima podría fallar la verificación.
 */
function readNotificationDataId(request: NextRequest, body: Record<string, unknown>): string | null {
  const fromQuery =
    firstString(request.nextUrl.searchParams.get('data.id')) ??
    firstString(request.nextUrl.searchParams.get('id'));

  if (fromQuery) return fromQuery;

  return firstString(asRecord(body.data)?.id) ?? firstString(body.id);
}

/** Tipo de notificación: `payment` es el único que nos interesa. */
function readNotificationType(request: NextRequest, body: Record<string, unknown>): string | null {
  return (
    firstString(request.nextUrl.searchParams.get('type')) ??
    firstString(request.nextUrl.searchParams.get('topic')) ??
    firstString(body.type) ??
    firstString(body.topic)
  );
}

export async function POST(request: NextRequest) {
  if (!isCommerceDbConfigured()) {
    return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
  }

  if (!isMercadoPagoConfigured()) {
    return NextResponse.json(
      { error: 'Mercado Pago is not configured', code: 'mercadopago_not_configured' },
      { status: 503 },
    );
  }

  // Sin secreto no hay forma de distinguir un pago real de una invención. Se
  // responde 503 (no 200) a propósito: MP reintenta y el cobro no se pierde.
  if (!isMercadoPagoWebhookConfigured()) {
    console.error(
      '[mp-webhook] MERCADOPAGO_WEBHOOK_SECRET is not set: cannot verify notifications. ' +
        'Copy the secret from Mercado Pago (Your integrations → Webhooks).',
    );
    return NextResponse.json(
      { error: 'Webhook secret is not configured', code: 'webhook_secret_not_configured' },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  let body: Record<string, unknown> = {};
  if (rawBody) {
    try {
      body = asRecord(JSON.parse(rawBody)) ?? {};
    } catch {
      // Algunos avisos llegan con un cuerpo que no es JSON. La firma y el query
      // string bastan para procesarlos, así que no lo tratamos como error.
      log('unparsable-body', { bytes: rawBody.length });
    }
  }

  const dataId = readNotificationDataId(request, body);
  const notificationType = readNotificationType(request, body);
  const xRequestId = request.headers.get('x-request-id');

  // ---- 1. Firma -------------------------------------------------------------
  const signature = verifyMercadoPagoWebhookSignature({
    xSignature: request.headers.get('x-signature'),
    xRequestId,
    dataId,
  });

  if (!signature.ok) {
    // Se registra el motivo: `SignatureMismatch` casi siempre es el secreto mal
    // copiado; `MissingSignatureHeader` suele ser un escaneo o un ataque.
    console.error('[mp-webhook] invalid signature', {
      reason: signature.reason,
      requestId: signature.requestId ?? xRequestId,
      timestamp: signature.timestamp,
      type: notificationType,
      dataId,
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // ---- 2. Sólo nos interesan los pagos --------------------------------------
  // MP también notifica `merchant_order`, `plan`, `subscription`… El aviso de pago
  // llega igual por su cuenta, así que el resto se acusa recibo y se ignora.
  if (notificationType && notificationType !== 'payment') {
    log('ignored-notification-type', { type: notificationType, dataId });
    return NextResponse.json({ received: true, ignored: notificationType }, { status: 200 });
  }

  if (!dataId) {
    log('ignored-missing-data-id', { type: notificationType });
    return NextResponse.json({ received: true, ignored: 'missing_data_id' }, { status: 200 });
  }

  // ---- 3. El pago, leído de la fuente real ----------------------------------
  let payment;
  try {
    payment = await fetchMercadoPagoPayment(dataId);
  } catch (error) {
    console.error('[mp-webhook] could not read the payment from Mercado Pago', { dataId, error });
    // 500 para que MP reintente el aviso.
    return NextResponse.json({ error: 'Could not read the payment' }, { status: 500 });
  }

  if (payment.status !== 'approved') {
    // `pending`, `in_process`, `rejected`, `cancelled`, `refunded`… Ninguno confirma
    // un pedido. Si más adelante se aprueba, MP avisa otra vez por este mismo canal.
    log('payment-not-approved', {
      paymentId: payment.id,
      status: payment.status,
      statusDetail: payment.statusDetail,
      externalReference: payment.externalReference,
    });
    return NextResponse.json({ received: true, status: payment.status }, { status: 200 });
  }

  // Un pago de sandbox no puede dar por pagado un pedido real. La contaminación
  // cruzada pasa cuando el desarrollo apunta a la misma base que producción.
  // La distinción es por entorno de Vercel (`VERCEL_ENV`), NO por `NODE_ENV`:
  // en Vercel `NODE_ENV` es `production` también en Preview, así que usarlo acá
  // hacía que un pago TEST jamás confirmara nada en Preview.
  if (isProductionRuntime() && payment.liveMode === false) {
    console.error('[mp-webhook] sandbox payment received in production: order left untouched', {
      paymentId: payment.id,
      externalReference: payment.externalReference,
    });
    return NextResponse.json({ received: true, ignored: 'sandbox_payment' }, { status: 200 });
  }

  if (!payment.externalReference) {
    console.error('[mp-webhook] approved payment without external_reference', {
      paymentId: payment.id,
    });
    return NextResponse.json({ received: true, ignored: 'missing_external_reference' }, { status: 200 });
  }

  // ---- 4. Confirmar el pedido (atómico e idempotente) ----------------------
  let order;
  try {
    order = await confirmOrderPayment({
      orderNumber: payment.externalReference,
      paymentId: payment.id,
      paymentMethod: payment.paymentMethodId,
      paidAmount: payment.transactionAmount,
      currency: payment.currencyId,
      paymentMetadata: {
        status: payment.status,
        statusDetail: payment.statusDetail,
        paymentMethodId: payment.paymentMethodId,
        paymentTypeId: payment.paymentTypeId,
        dateApproved: payment.dateApproved,
        liveMode: payment.liveMode,
      },
    });
  } catch (error) {
    console.error('[mp-webhook] could not confirm the order', {
      paymentId: payment.id,
      orderNumber: payment.externalReference,
      error,
    });
    return NextResponse.json({ error: 'Could not confirm the order' }, { status: 500 });
  }

  if (!order) {
    // Pago aprobado cuyo `external_reference` no es de esta base: casi siempre una
    // credencial de prueba apuntando a un webhook de producción.
    console.error('[mp-webhook] approved payment for an unknown order number', {
      paymentId: payment.id,
      orderNumber: payment.externalReference,
    });
    return NextResponse.json({ received: true, ignored: 'unknown_order' }, { status: 200 });
  }

  const audit = readOrderPaymentAudit(order);

  // Un cobro real que no se pudo aplicar es lo único que exige acción humana.
  if (audit?.needsReview || order.paymentStatus !== 'paid' || order.status !== 'confirmed') {
    console.error(
      '[mp-webhook] PAYMENT NEEDS MANUAL REVIEW: money was collected but the order was not confirmed',
      {
        paymentId: payment.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        paymentStatus: order.paymentStatus,
        paidAmount: payment.transactionAmount,
        orderTotal: order.total,
        amountMismatch: audit?.amountMismatch ?? null,
      },
    );
  }

  // Pagó, pero el stock ya no está (el reaper lo liberó y otra persona lo compró).
  // El pedido queda confirmado igual: el dinero ya entró. Hay que reponer o reembolsar.
  if (audit?.stockConflict) {
    console.error(
      '[mp-webhook] PAID WITHOUT STOCK: re-reservation failed, restock or refund',
      {
        paymentId: payment.id,
        orderNumber: order.orderNumber,
        reason: audit.stockConflictReason,
      },
    );
  }

  // Aviso a la TIENDA (best-effort): recién ahora el pedido está pagado y suena la
  // alarma para prepararlo. No puede hacer fallar la respuesta; `notifyNewOrderSafely`
  // nunca lanza. La clave de idempotencia del correo evita duplicados en reintentos.
  if (order.status === 'confirmed' && order.paymentStatus === 'paid') {
    const storeAviso = await notifyNewOrderSafely(order.id);
    log('store-notified', { orderNumber: order.orderNumber, status: storeAviso.status });
  }

  // Reintento sobre un pedido ya pagado: no es un error, es idempotencia funcionando.
  log('handled', {
    paymentId: payment.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
  });

  return NextResponse.json(
    { received: true, orderNumber: order.orderNumber, status: order.status },
    { status: 200 },
  );
}
