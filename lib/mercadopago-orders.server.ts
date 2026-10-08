/**
 * lib/mercadopago-orders.server.ts — Checkout Pro vía **Orders API** (CLEAN-ROOM).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ¿QUÉ ES ESTO?
 *
 *  Una integración NUEVA y AISLADA de Mercado Pago basada en la Orders API
 *  (`POST /v1/orders` + tópico `order`), creada para DEMOSTRAR si un WebHook
 *  automático real de una aplicación Mercado Pago nueva valida su firma.
 *
 *  NO reemplaza ni toca la integración antigua basada en Preferences
 *  (`lib/mercadopago.server.ts`, `/api/payments/*`). Convive en paralelo y no
 *  comparte nada con ella: ni cliente, ni token, ni secret, ni helpers HMAC.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  ─── AISLAMIENTO TOTAL (regla dura de este módulo) ──────────────────────────
 *  · Este archivo NUNCA importa `lib/mercadopago.server.ts` ni `lib/env.ts`.
 *  · Lee SOLO tres variables, con lectura EXPLÍCITA de `process.env`:
 *        MP_ORDERS_ACCESS_TOKEN
 *        MP_ORDERS_WEBHOOK_SECRET
 *        MP_ORDERS_BACK_URL_BASE
 *  · NO usa `getPrefixedEnv`, NO acepta prefijos inyectados por integraciones y NO
 *    cae a las variables del flujo legacy (nombrarlas acá sería documentar una
 *    dependencia que no existe: este archivo no las menciona ni las lee). Si falta
 *    una variable nueva, la función falla cerrado.
 *  · `MP_ORDERS_PUBLIC_KEY` NO se lee: en este flujo TODO es backend (crear orden,
 *    validar firma, consultar la orden). La public key es para SDKs de frontend
 *    (Bricks) y acá no hace falta.
 *
 *  ─── CREDENCIALES ───────────────────────────────────────────────────────────
 *  Las credenciales se configuran a mano en Vercel (scope Preview). Este módulo
 *  jamás las imprime, ni las escribe, ni las incluye en una respuesta. Tampoco se
 *  loguean cabeceras `Authorization` ni el `x-signature` completo.
 *
 *  ─── AUTORÍA DEL CÓDIGO ─────────────────────────────────────────────────────
 *  La llamada de creación/consulta se hace contra la API REST con `fetch` (rutas y
 *  campos tomados de la referencia oficial), en vez de reutilizar el cliente del
 *  SDK de la integración vieja. La VALIDACIÓN DE FIRMA sí usa el validador oficial
 *  del SDK (`WebhookSignatureValidator`), que es stateless y no depende del cliente
 *  cacheado: era el mecanismo documentado y no se reimplementa a mano.
 */

import {
  InvalidWebhookSignatureError,
  SignatureFailureReason,
  WebhookSignatureValidator,
} from 'mercadopago';

/** Base de la API de Mercado Pago. */
const MERCADOPAGO_API_BASE = 'https://api.mercadopago.com';

/** Timeout de nuestras llamadas a MP (MP corta la espera del webhook a los ~22 s). */
const API_TIMEOUT_MS = 10_000;

/**
 * Email de comprador por defecto para la orden QA.
 *
 * La referencia oficial de `Create order` documenta el error `invalid_email_for_sandbox`:
 *   "Email format is invalid for sandbox environment, must contain @testuser.com".
 * Por eso el default termina en `@testuser.com` (ajuste exigido por la doc) y NO el
 * `qa.mp.sandbox@example.com` del borrador. Se puede sobrescribir desde el body del
 * endpoint de creación sin tocar código.
 */
export const DEFAULT_QA_PAYER_EMAIL = 'qa.mp.orders@testuser.com';

/** Prefijo de la referencia externa de las órdenes QA clean-room. */
export const QA_EXTERNAL_REFERENCE_PREFIX = 'UMANTAI-MP-ORDERS-QA-';

// =============================================================================
//  1. CONFIGURACIÓN (lectura explícita, fail-closed, sin legacy)
// =============================================================================

/**
 * Lee una variable de entorno EXACTA (sin prefijos, sin fallbacks).
 *
 * A propósito NO se usa `getPrefixedEnv`: esa función acepta los prefijos de Vercel
 * y podría resolver una variable distinta de la declarada, rompiendo el aislamiento
 * que este experimento necesita.
 */
function readExactEnv(key: string): string {
  const raw = process.env[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getMpOrdersAccessToken(): string {
  return readExactEnv('MP_ORDERS_ACCESS_TOKEN');
}

export function getMpOrdersWebhookSecret(): string {
  return readExactEnv('MP_ORDERS_WEBHOOK_SECRET');
}

export function getMpOrdersBackUrlBase(): string {
  return readExactEnv('MP_ORDERS_BACK_URL_BASE');
}

/** ¿Podemos llamar a la API de Orders? Si no, las rutas responden 503. */
export function isMpOrdersConfigured(): boolean {
  return getMpOrdersAccessToken().length > 0;
}

/** ¿Podemos verificar la firma de un webhook? Si no, el webhook responde 503. */
export function isMpOrdersWebhookConfigured(): boolean {
  return getMpOrdersWebhookSecret().length > 0;
}

// =============================================================================
//  2. TIPOS
// =============================================================================

/** Un ítem de la orden, en la forma que acepta `POST /v1/orders`. */
export interface MpOrdersItemInput {
  title: string;
  /** Precio unitario como string decimal, p. ej. `"1.00"`. */
  unitPrice: string;
  quantity: number;
}

/** Lo que devolvemos de una orden recién creada (nunca incluye credenciales). */
export interface MpOrdersCreatedOrder {
  orderId: string;
  status: string | null;
  checkoutUrl: string;
  externalReference: string;
  totalAmount: string;
}

/** Lo mínimo que nos interesa de una orden al consultarla tras el webhook. */
export interface MpOrdersOrderSnapshot {
  orderId: string;
  status: string | null;
  statusDetail: string | null;
  externalReference: string | null;
  totalAmount: string | null;
  totalPaidAmount: string | null;
  processingMode: string | null;
  type: string | null;
  /** Identificadores NO personales que la API pueda devolver. */
  applicationId: string | null;
  collectorId: string | null;
  /** ¿Vino email de comprador? Solo PRESENCIA, nunca el valor. */
  payerEmailPresent: boolean;
  /** Estado del pago dentro de la orden (si la orden trae `transactions.payments`). */
  paymentStatus: string | null;
  paymentStatusDetail: string | null;
}

/** Resultado de validar la firma. No lanza: la ruta traduce a HTTP. */
export type MpOrdersSignatureCheck =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason; requestId: string | null; timestamp: string | null };

// =============================================================================
//  3. HELPERS NUMÉRICOS / DE FORMATO (aritmética en centavos, sin floats)
// =============================================================================

/** Convierte `"1.00"`/`"1"` a centavos enteros. `null` si no es un decimal válido. */
export function parseAmountToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > 2) return null;
  const cents = fraction.padEnd(2, '0');
  return Number(whole) * 100 + Number(cents);
}

/** Formatea centavos enteros a string decimal con 2 posiciones (`100` → `"1.00"`). */
export function formatCents(cents: number): string {
  const safe = Math.max(0, Math.round(cents));
  const whole = Math.floor(safe / 100);
  const fraction = String(safe % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// =============================================================================
//  4. CONSTRUCCIÓN DEL BODY DE LA ORDEN (puro, sin red)
// =============================================================================

/** Body de `POST /v1/orders` en la forma exacta que documenta la referencia. */
export interface MpOrdersCreateBody {
  type: 'online';
  processing_mode: 'manual';
  total_amount: string;
  external_reference: string;
  payer: { email: string };
  items: Array<{
    title: string;
    unit_price: string;
    quantity: number;
    unit_measure: string;
    total_amount: string;
  }>;
  config?: {
    online: {
      success_url: string;
      failure_url: string;
      pending_url: string;
    };
  };
}

export class MpOrdersValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MpOrdersValidationError';
  }
}

/**
 * URLs de regreso derivadas de `MP_ORDERS_BACK_URL_BASE`.
 *
 * Si la base no está configurada (o no es una URL absoluta válida) se devuelve
 * `null` y la orden se crea SIN `config`: es un campo opcional y no inventamos URLs.
 */
export function resolveMpOrdersBackUrls(
  backUrlBase: string,
): MpOrdersCreateBody['config'] | null {
  const base = backUrlBase.trim().replace(/\/+$/, '');
  if (!base) return null;
  try {
    // Valida que sea absoluta; descarta valores como "umantai.com" o "//x".
    new URL(base);
  } catch {
    return null;
  }
  return {
    online: {
      success_url: `${base}/?mp_orders=success`,
      failure_url: `${base}/?mp_orders=failure`,
      pending_url: `${base}/?mp_orders=pending`,
    },
  };
}

/**
 * Construye el body de creación de la orden.
 *
 * Reglas de la doc oficial (`Create order`):
 *   · `type` = `"online"` y `processing_mode` = `"manual"` son los ÚNICOS valores
 *     válidos en Checkout Pro.
 *   · `total_amount` debe ser EXACTAMENTE la suma de `unit_price × quantity`.
 *     La aritmética va en centavos enteros para no arrastrar errores de float.
 *   · `payer.email` es obligatorio dentro de `payer`.
 *
 * NO se envía `notification_url`: la Orders API no lo acepta; los webhooks se
 * configuran a nivel de APLICACIÓN (Tus integraciones → Webhooks → tópico Order).
 * Se lanza `MpOrdersValidationError` ante datos inválidos (fail-closed).
 */
export function buildMpOrdersCreateBody(input: {
  externalReference: string;
  payerEmail: string;
  items: readonly MpOrdersItemInput[];
  backUrlBase?: string;
}): MpOrdersCreateBody {
  const externalReference = input.externalReference.trim();
  if (!externalReference) throw new MpOrdersValidationError('external_reference_required');
  // La doc acota `external_reference` a 64 caracteres.
  if (externalReference.length > 64) throw new MpOrdersValidationError('external_reference_too_long');

  const payerEmail = input.payerEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
    throw new MpOrdersValidationError('payer_email_invalid');
  }

  if (input.items.length === 0) throw new MpOrdersValidationError('items_required');

  let totalCents = 0;
  const items = input.items.map((item) => {
    const title = item.title.trim();
    if (!title) throw new MpOrdersValidationError('item_title_required');

    const unitCents = parseAmountToCents(item.unitPrice);
    if (unitCents === null) throw new MpOrdersValidationError('item_unit_price_invalid');
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new MpOrdersValidationError('item_quantity_invalid');
    }

    const itemTotalCents = unitCents * item.quantity;
    totalCents += itemTotalCents;

    return {
      title,
      unit_price: formatCents(unitCents),
      quantity: item.quantity,
      unit_measure: 'unit',
      total_amount: formatCents(itemTotalCents),
    };
  });

  const config = resolveMpOrdersBackUrls(input.backUrlBase ?? '');

  return {
    type: 'online',
    processing_mode: 'manual',
    total_amount: formatCents(totalCents),
    external_reference: externalReference,
    payer: { email: payerEmail },
    items,
    ...(config ? { config } : {}),
  };
}

// =============================================================================
//  5. LLAMADAS A LA API (fetch directo, sin cliente compartido)
// =============================================================================

/** Error de transporte/negocio de la API de Orders, ya sanitizado. */
export class MpOrdersApiError extends Error {
  readonly httpStatus: number;
  readonly mpCode: string | null;

  constructor(httpStatus: number, mpCode: string | null, message: string) {
    super(message);
    this.name = 'MpOrdersApiError';
    this.httpStatus = httpStatus;
    this.mpCode = mpCode;
  }
}

/**
 * Extrae `code`/`message` de un error de MP SIN arrastrar nada más.
 *
 * Del cuerpo de error solo se conservan dos campos cortos y acotados: el token
 * nunca viaja en un cuerpo de error de MP, y así no se loguea el payload entero.
 */
function describeMpError(status: number, payload: unknown): MpOrdersApiError {
  const record = asRecord(payload);
  const code = asNonEmptyString(record?.code) ?? asNonEmptyString(record?.error);
  const message = asNonEmptyString(record?.message) ?? asNonEmptyString(record?.error);
  const detail = code || message ? `${code ?? 'error'}: ${(message ?? '').slice(0, 300)}` : 'mp_request_failed';
  return new MpOrdersApiError(status, code, detail);
}

async function mpFetch(path: string, init: RequestInit, accessToken: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${MERCADOPAGO_API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw describeMpError(response.status, payload);
  return payload;
}

/**
 * Crea una orden QA contra la API de Orders.
 *
 * `idempotencyKey` DEBE ser un UUID nuevo por intento (la doc lo exige y MP rechaza
 * reutilizarlo con `idempotency_key_already_used`).
 */
export async function createMpOrdersOrder(options: {
  body: MpOrdersCreateBody;
  idempotencyKey: string;
  accessToken: string;
}): Promise<MpOrdersCreatedOrder> {
  const payload = await mpFetch(
    '/v1/orders',
    {
      method: 'POST',
      headers: { 'X-Idempotency-Key': options.idempotencyKey },
      body: JSON.stringify(options.body),
    },
    options.accessToken,
  );

  const record = asRecord(payload);
  const orderId = asNonEmptyString(record?.id);
  const checkoutUrl = asNonEmptyString(record?.checkout_url);
  if (!orderId || !checkoutUrl) {
    throw new MpOrdersApiError(502, 'orders_response_incomplete', 'orders_response_incomplete');
  }

  return {
    orderId,
    status: asNonEmptyString(record?.status),
    checkoutUrl,
    externalReference:
      asNonEmptyString(record?.external_reference) ?? options.body.external_reference,
    totalAmount: asNonEmptyString(record?.total_amount) ?? options.body.total_amount,
  };
}

/**
 * Consulta una orden por id (`GET /v1/orders/{id}`).
 *
 * Este es el recurso correcto tras el webhook del tópico `order`: el `data.id` que
 * llega ES un id de Order, y la doc recomienda este GET para completar los datos.
 * NO se usa `Payment.get` (eso es la semántica de la integración vieja).
 */
export async function fetchMpOrdersOrder(options: {
  orderId: string;
  accessToken: string;
}): Promise<MpOrdersOrderSnapshot> {
  const payload = await mpFetch(
    `/v1/orders/${encodeURIComponent(options.orderId)}`,
    { method: 'GET' },
    options.accessToken,
  );

  const record = asRecord(payload);
  const integrationData = asRecord(record?.integration_data);
  const payer = asRecord(record?.payer);
  const payments = asRecord(asRecord(record?.transactions)?.payments);
  const firstPayment = Array.isArray(payments) ? asRecord(payments[0]) : null;

  return {
    orderId: asNonEmptyString(record?.id) ?? options.orderId,
    status: asNonEmptyString(record?.status),
    statusDetail: asNonEmptyString(record?.status_detail),
    externalReference: asNonEmptyString(record?.external_reference),
    totalAmount: asNonEmptyString(record?.total_amount),
    totalPaidAmount: asNonEmptyString(record?.total_paid_amount),
    processingMode: asNonEmptyString(record?.processing_mode),
    type: asNonEmptyString(record?.type),
    applicationId: asNonEmptyString(integrationData?.application_id),
    collectorId: asNonEmptyString(record?.user_id),
    payerEmailPresent: asNonEmptyString(payer?.email) !== null,
    paymentStatus: asNonEmptyString(firstPayment?.status),
    paymentStatusDetail: asNonEmptyString(firstPayment?.status_detail),
  };
}

// =============================================================================
//  6. FIRMA DEL WEBHOOK
// =============================================================================

/**
 * Verifica que la notificación la haya firmado Mercado Pago.
 *
 * Usa el `WebhookSignatureValidator` OFICIAL del SDK (mecanismo documentado y
 * vigente): no se reimplementa el HMAC a mano. El validador arma el manifest
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` omitiendo los pares ausentes y
 * compara en tiempo constante.
 *
 * Igual que la integración vieja, NO se pasa `toleranceSeconds`: MP reintenta hasta
 * recibir un 2xx y un reintento legítimo puede llegar con el `ts` original horas
 * después; con ventana de tolerancia ese reintento sería rechazado para siempre.
 */
export function verifyMpOrdersWebhookSignature(input: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string;
}): MpOrdersSignatureCheck {
  if (!input.secret) throw new Error('mp_orders_webhook_secret_not_configured');

  try {
    WebhookSignatureValidator.validate({
      xSignature: input.xSignature,
      xRequestId: input.xRequestId,
      dataId: input.dataId,
      secret: input.secret,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) {
      return {
        ok: false,
        reason: error.reason,
        requestId: error.requestId ?? null,
        timestamp: error.timestamp ?? null,
      };
    }
    throw error;
  }
}
