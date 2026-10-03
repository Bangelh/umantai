/**
 * lib/mercadopago.server.ts — Checkout Pro (Mercado Pago), solo servidor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ¿QUÉ ES UNA "PREFERENCE"?
 *
 *  En Checkout Pro la app NO cobra: la app le describe a Mercado Pago QUÉ se está
 *  vendiendo y MP devuelve una URL (`init_point`) donde el comprador paga con
 *  Yape, Plin, tarjeta o saldo. Nosotros solo guardamos el id de esa Preference
 *  y esperamos la confirmación (webhook / API de pagos) para marcar el pedido.
 *
 *  Consecuencia de diseño: acá NUNCA se confía en montos que vengan del navegador.
 *  Los items y el total salen del pedido ya persistido en Postgres, que a su vez
 *  los recalculó en el servidor al crearlo (`app/api/orders/route.ts`).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Variables de entorno (todas opcionales salvo la primera; aceptan los prefijos
 *  de Vercel `BANGELH_` / `UMANTAI_URL_` vía `getPrefixedEnv`):
 *
 *   MERCADOPAGO_ACCESS_TOKEN      (requerida)  Private key de tu aplicación.
 *                                              Test: "TEST-..." / APP_USR de usuario de prueba.
 *                                              Prod: "APP_USR-..." de tu cuenta real.
 *   MERCADOPAGO_SANDBOX           "true" → usa `sandbox_init_point` en vez de `init_point`.
 *   MERCADOPAGO_BACK_URL_BASE     Fuerza la base de `back_urls`/`notification_url`
 *                                 (útil si estás detrás de un proxy raro).
 *   MERCADOPAGO_STATEMENT_DESCRIPTOR  Texto en el estado de cuenta del comprador.
 *                                 OJO: no todos los países lo soportan; por eso solo
 *                                 se manda si lo defines explícitamente.
 *   MERCADOPAGO_WEBHOOK_SECRET    (requerida para cobrar)  Clave secreta de la firma
 *                                 de los webhooks (Tus integraciones → Webhooks).
 *                                 Sin ella no se puede verificar que una notificación
 *                                 venga realmente de Mercado Pago.
 */

import {
  InvalidWebhookSignatureError,
  MercadoPagoConfig,
  Payment,
  Preference,
  SignatureFailureReason,
  WebhookSignatureValidator,
} from 'mercadopago';
import { getPrefixedEnv } from './env';
import type { OrderItem, OrderWithItems } from './commerce';

/** Timeout de las llamadas a la API de MP (el default del SDK son 10s). */
const API_TIMEOUT_MS = 10_000;

/** MP rechaza títulos muy largos; nos quedamos por debajo del límite. */
const MAX_ITEM_TITLE_LENGTH = 250;

/**
 * Cuánto tiempo reutilizamos una Preference ya generada.
 *
 * Solo protege el caso "el comprador hace doble clic / reintenta el POST": en vez de
 * crear 5 Preferences para el mismo pedido, devolvemos la misma URL. Pasada la
 * ventana se genera una nueva (una Preference ya pagada no se puede volver a usar).
 */
const PREFERENCE_REUSE_WINDOW_MS = 10 * 60 * 1000;

/** DNI peruano: 8 dígitos. Si no cuadra, es mejor no mandarlo que mandar basura. */
const DNI_PATTERN = /^\d{8}$/;

// =============================================================================
//  1. CONFIGURACIÓN
// =============================================================================

function readEnv(key: string): string {
  return (getPrefixedEnv(key) ?? '').trim();
}

export function getMercadoPagoAccessToken(): string {
  return readEnv('MERCADOPAGO_ACCESS_TOKEN');
}

/** ¿Está configurada la pasarela? Si no, la ruta responde 503 en vez de explotar. */
export function isMercadoPagoConfigured(): boolean {
  return getMercadoPagoAccessToken().length > 0;
}

/**
 * Clave con la que Mercado Pago firma sus notificaciones (HMAC-SHA256).
 *
 * No es la misma que el access token: se copia del panel, en Tus integraciones →
 * Webhooks (o en la sección de firma secreta). La firma es lo ÚNICO que impide que
 * cualquiera que descubra la URL del webhook se invente un pago aprobado.
 */
export function getMercadoPagoWebhookSecret(): string {
  return readEnv('MERCADOPAGO_WEBHOOK_SECRET');
}

/** ¿Podemos verificar la autenticidad de un webhook? Si no, la ruta responde 503. */
export function isMercadoPagoWebhookConfigured(): boolean {
  return getMercadoPagoWebhookSecret().length > 0;
}

function preferSandboxInitPoint(): boolean {
  return /^(1|true|yes|on)$/i.test(readEnv('MERCADOPAGO_SANDBOX'));
}

/**
 * Cliente del SDK cacheado por instancia.
 *
 * Se re-crea si cambia el token (por ejemplo, al pasar de credenciales de prueba a
 * las de producción sin reiniciar el proceso).
 */
let cachedClient: MercadoPagoConfig | null = null;
let cachedToken: string | null = null;

function getClient(): MercadoPagoConfig {
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) throw new Error('mercadopago_not_configured');

  if (!cachedClient || cachedToken !== accessToken) {
    cachedClient = new MercadoPagoConfig({
      accessToken,
      options: { timeout: API_TIMEOUT_MS },
    });
    cachedToken = accessToken;
  }

  return cachedClient;
}

// =============================================================================
//  2. TIPOS
// =============================================================================

/** Lo que dejamos guardado en `orders.metadata.payment.mercadoPago`. */
export interface StoredCheckoutPreference {
  preferenceId: string;
  /** URL a la que hay que mandar al comprador (ya resuelta según el modo). */
  initPoint: string;
  sandboxInitPoint: string | null;
  /**
   * URL EXACTA enviada a Mercado Pago como `notification_url`. Se persiste junto al
   * resto del snapshot para poder auditar (sin adivinar) a dónde notifica MP.
   *
   * `null` sólo en snapshots antiguos creados antes de este campo: nunca se inventa
   * un valor retroactivo (el host pudo haber cambiado entre la creación y la lectura).
   */
  notificationUrl: string | null;
  /** ISO 8601, para saber si todavía sirve reutilizarla. */
  createdAt: string;
}

export interface CreateCheckoutPreferenceOptions {
  /**
   * Base absoluta para `back_urls` y `notification_url` (ej. `https://umantai.com`).
   * Sin protocolo, MP rechaza la Preference.
   */
  origin: string;
  /**
   * UUID que viaja en `requestOptions.idempotencyKey`. Un reintento de red con la
   * misma clave NO crea una segunda Preference.
   */
  idempotencyKey?: string;
}

// =============================================================================
//  3. HELPERS
// =============================================================================

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

/** Redondeo a 2 decimales: NUMERIC llega como string y los floats tienen cola. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** `color:black|storage:256gb` → `color: black · storage: 256gb` (lo que ve el comprador). */
function describeVariant(item: OrderItem): string | null {
  const parts = Object.entries(item.variant ?? {})
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `${key}: ${String(value).trim()}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Lee la Preference guardada en el pedido (si existe y está bien formada).
 *
 * Vive en `metadata` (JSONB) a propósito: no requiere una migración y es data
 * operativa, no parte del modelo de pedidos.
 */
export function readStoredCheckoutPreference(order: Pick<OrderWithItems, 'metadata'>): StoredCheckoutPreference | null {
  const payment = asRecord(order.metadata?.payment);
  const mercadoPago = asRecord(payment?.mercadoPago);
  if (!mercadoPago) return null;

  const preferenceId = asNonEmptyString(mercadoPago.preferenceId);
  const initPoint = asNonEmptyString(mercadoPago.initPoint);
  const createdAt = asNonEmptyString(mercadoPago.createdAt);
  if (!preferenceId || !initPoint || !createdAt) return null;

  return {
    preferenceId,
    initPoint,
    sandboxInitPoint: asNonEmptyString(mercadoPago.sandboxInitPoint),
    notificationUrl: asNonEmptyString(mercadoPago.notificationUrl),
    createdAt,
  };
}

/** ¿La Preference guardada sigue dentro de la ventana de reutilización? */
export function isStoredPreferenceFresh(
  stored: StoredCheckoutPreference,
  now: number = Date.now(),
): boolean {
  const created = Date.parse(stored.createdAt);
  if (!Number.isFinite(created)) return false;
  return now - created < PREFERENCE_REUSE_WINDOW_MS;
}

// =============================================================================
//  4. CONSTRUCCIÓN DEL BODY DE LA PREFERENCE
// =============================================================================

type PreferenceItem = {
  id: string;
  title: string;
  description?: string;
  quantity: number;
  currency_id: string;
  unit_price: number;
  picture_url?: string;
};

/**
 * Items de la Preference a partir de las líneas del pedido.
 *
 * Checkout Pro NO admite líneas negativas, así que un descuento no se puede
 * representar línea a línea. Si la suma de los items no cuadra con `orders.total`
 * (hay descuento, o un recargo que no modelamos), mandamos UNA sola línea con el
 * total: preferimos que el comprador pague exactamente lo que dice el pedido antes
 * que un carrito bonito con un monto distinto.
 */
function buildItems(order: OrderWithItems): PreferenceItem[] {
  const currency = order.currency;
  const items: PreferenceItem[] = order.items.map((item) => {
    const variant = describeVariant(item);
    return {
      id: item.productSlug,
      title: truncate(item.productName, MAX_ITEM_TITLE_LENGTH),
      ...(variant ? { description: truncate(variant, MAX_ITEM_TITLE_LENGTH) } : {}),
      quantity: item.quantity,
      currency_id: currency,
      unit_price: round2(item.unitPrice),
      ...(item.imageUrl ? { picture_url: item.imageUrl } : {}),
    };
  });

  if (order.shippingTotal > 0) {
    items.push({
      id: 'shipping',
      title: 'Shipping',
      quantity: 1,
      currency_id: currency,
      unit_price: round2(order.shippingTotal),
    });
  }

  const itemsTotal = round2(
    items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0),
  );

  if (Math.abs(itemsTotal - round2(order.total)) > 0.009) {
    return [
      {
        id: order.orderNumber,
        title: truncate(`Order ${order.orderNumber}`, MAX_ITEM_TITLE_LENGTH),
        quantity: 1,
        currency_id: currency,
        unit_price: round2(order.total),
      },
    ];
  }

  return items;
}

type PreferencePayer = {
  email?: string;
  name?: string;
  surname?: string;
  phone?: { area_code?: string; number?: string };
  identification?: { type: string; number: string };
};

/**
 * Datos del comprador guardados por el checkout en `orders.metadata.buyer`.
 * Pre-rellenarlos evita que el comprador tenga que teclear todo de nuevo en MP.
 */
function buildPayer(order: OrderWithItems): PreferencePayer {
  const buyer = asRecord(order.metadata?.buyer);
  const payer: PreferencePayer = { email: order.contactEmail };

  const fullName = asNonEmptyString(buyer?.fullName);
  if (fullName) {
    const [first, ...rest] = fullName.split(/\s+/);
    payer.name = first;
    if (rest.length > 0) payer.surname = rest.join(' ');
  }

  const docType = asNonEmptyString(buyer?.docType)?.toUpperCase();
  const docNumber = asNonEmptyString(buyer?.docNumber)?.replace(/\s+/g, '');
  if (docType === 'DNI' && docNumber && DNI_PATTERN.test(docNumber)) {
    payer.identification = { type: 'DNI', number: docNumber };
  }

  const phone = asNonEmptyString(buyer?.phone) ?? order.contactPhone;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('51')) {
      payer.phone = { area_code: '51', number: digits.slice(2) };
    } else if (digits.length >= 6) {
      payer.phone = { number: digits };
    }
  }

  return payer;
}

// =============================================================================
//  5. API PÚBLICA
// =============================================================================

/**
 * URL EXACTA de notificación que se envía a Mercado Pago.
 *
 * Única fuente de verdad: la MISMA cadena se manda como `notification_url` y se
 * persiste en `orders.metadata.payment.mercadoPago.notificationUrl`. Nunca se
 * recalcula por separado, para que lo que viaja sea lo que se guarda.
 */
export function resolveNotificationUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/payments/webhook`;
}

/** Tipo del body de la Preference, derivado del SDK sin importar tipos internos. */
type PreferenceRequestBody = Parameters<Preference['create']>[0]['body'];

/**
 * Construye el body de la Preference (puro, sin red) y devuelve además la URL de
 * notificación exacta que se usará. Se separa de la llamada a MP para poder
 * demostrar en tests que `notification_url` y el dato de auditoría son la MISMA cadena.
 */
export function buildCheckoutPreferenceBody(
  order: OrderWithItems,
  rawOrigin: string,
): { body: PreferenceRequestBody; notificationUrl: string } {
  const origin = rawOrigin.replace(/\/+$/, '');
  const notificationUrl = resolveNotificationUrl(origin);

  const backUrl = (flag: 'exitoso' | 'pendiente' | 'fallido') =>
    `${origin}/pedido/${order.publicToken}?pago=${flag}`;

  // MP exige `back_urls` en HTTPS para poder usar `auto_return`; en local (http)
  // omitimos `auto_return` en vez de comerse un 400 del API.
  const isHttps = origin.startsWith('https://');

  const statementDescriptor = readEnv('MERCADOPAGO_STATEMENT_DESCRIPTOR');

  const body: PreferenceRequestBody = {
    items: buildItems(order),
    payer: buildPayer(order),
    // Referencia que MP nos devuelve en el pago: con esto se sabe a qué pedido
    // pertenece un cobro sin depender de nuestro estado interno.
    external_reference: order.orderNumber,
    back_urls: {
      success: backUrl('exitoso'),
      pending: backUrl('pendiente'),
      failure: backUrl('fallido'),
    },
    ...(isHttps ? { auto_return: 'approved' } : {}),
    notification_url: notificationUrl,
    metadata: {
      order_id: order.id,
      order_number: order.orderNumber,
      public_token: order.publicToken,
    },
    ...(statementDescriptor ? { statement_descriptor: statementDescriptor } : {}),
  };

  return { body, notificationUrl };
}

/**
 * Snapshot de auditoría que se escribe en `orders.metadata.payment`. Incluye la
 * `notificationUrl` REAL usada, para poder leerla después sin recalcular nada.
 */
export function toStoredPreferenceSnapshot(preference: StoredCheckoutPreference) {
  return {
    mercadoPago: {
      preferenceId: preference.preferenceId,
      initPoint: preference.initPoint,
      sandboxInitPoint: preference.sandboxInitPoint,
      notificationUrl: preference.notificationUrl,
      createdAt: preference.createdAt,
    },
  };
}

/**
 * Crea (o reutiliza) la Preference de pago del pedido y devuelve la URL del checkout.
 *
 * NO valida el estado del pedido: de eso se encarga la ruta, que es quien tiene el
 * contexto HTTP (404/409/503). Acá solo se construye el cobro.
 */
export async function createCheckoutPreference(
  order: OrderWithItems,
  options: CreateCheckoutPreferenceOptions,
): Promise<StoredCheckoutPreference> {
  const client = getClient();
  const preference = new Preference(client);

  const { body, notificationUrl } = buildCheckoutPreferenceBody(order, options.origin);

  const response = await preference.create({
    body,
    ...(options.idempotencyKey ? { requestOptions: { idempotencyKey: options.idempotencyKey } } : {}),
  });

  const productionUrl = response.init_point ?? null;
  const sandboxUrl = response.sandbox_init_point ?? null;
  const chosen = preferSandboxInitPoint()
    ? sandboxUrl ?? productionUrl
    : productionUrl ?? sandboxUrl;

  if (!response.id || !chosen) {
    throw new Error('mercadopago_preference_without_init_point');
  }

  return {
    preferenceId: response.id,
    initPoint: chosen,
    sandboxInitPoint: sandboxUrl,
    notificationUrl,
    createdAt: new Date().toISOString(),
  };
}

// =============================================================================
//  6. WEBHOOK — firma y lectura del pago
//
//  Un webhook es una URL pública: cualquiera puede hacerle POST y decir "este
//  pedido está pagado". Por eso NUNCA se confía en el cuerpo del aviso:
//   1. Se verifica la firma HMAC-SHA256 contra el secreto compartido.
//   2. El cuerpo sólo aporta un ID.
//   3. Los datos que DECIDEN (estado, monto, moneda) se le piden a la API de MP
//      con nuestro access token — la única fuente que no se puede falsificar.
// =============================================================================

/** Resultado de verificar la firma. No se lanza excepción: la ruta decide el HTTP. */
export type WebhookSignatureCheck =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason; requestId: string | null; timestamp: string | null };

/**
 * Verifica que la notificación la haya firmado Mercado Pago.
 *
 * ⚠️ A PROPÓSITO no se pasa `toleranceSeconds`: Mercado Pago reintenta una
 * notificación hasta que recibe un 2xx, y un reintento puede llegar con el `ts`
 * original horas después. Con una ventana de tolerancia, ese reintento legítimo
 * sería rechazado para siempre y el pedido pagado nunca se confirmaría.
 * El replay no es un riesgo acá: el único efecto de procesar dos veces el mismo
 * pago es idempotente (ver `confirm_order_payment` en la migración 002).
 */
export function verifyMercadoPagoWebhookSignature(input: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
}): WebhookSignatureCheck {
  const secret = getMercadoPagoWebhookSecret();
  if (!secret) throw new Error('mercadopago_webhook_secret_not_configured');

  try {
    WebhookSignatureValidator.validate({
      xSignature: input.xSignature,
      xRequestId: input.xRequestId,
      dataId: input.dataId,
      secret,
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

/**
 * Lo mínimo que necesitamos de un pago para decidir el destino de un pedido.
 *
 * Se normaliza acá (y no se pasa el recurso crudo del SDK hacia arriba) para que el
 * resto del código no dependa de la forma exacta del API de Mercado Pago.
 */
export interface MercadoPagoPaymentSnapshot {
  id: string;
  /** `approved` es el único estado que libera un pedido. */
  status: string | null;
  /** `accredited` para Yape/Plin aprobados, `cc_rejected_*` para rechazos, etc. */
  statusDetail: string | null;
  /** `orders.order_number` — así se sabe a qué pedido pertenece el cobro. */
  externalReference: string | null;
  transactionAmount: number | null;
  currencyId: string | null;
  paymentMethodId: string | null;
  paymentTypeId: string | null;
  dateApproved: string | null;
  /** `false` = pago de sandbox. Distinguirlo evita dar por pagado un pedido de prueba. */
  liveMode: boolean | null;
}

/** Lee el pago desde la API de Mercado Pago (nuestra fuente de verdad). */
export async function fetchMercadoPagoPayment(paymentId: string): Promise<MercadoPagoPaymentSnapshot> {
  const client = getClient();
  const payment = await new Payment(client).get({ id: paymentId });

  return {
    id: String(payment.id ?? paymentId),
    status: asNonEmptyString(payment.status),
    statusDetail: asNonEmptyString(payment.status_detail),
    externalReference: asNonEmptyString(payment.external_reference),
    transactionAmount: typeof payment.transaction_amount === 'number' ? payment.transaction_amount : null,
    currencyId: asNonEmptyString(payment.currency_id),
    paymentMethodId: asNonEmptyString(payment.payment_method_id),
    paymentTypeId: asNonEmptyString(payment.payment_type_id),
    dateApproved: asNonEmptyString(payment.date_approved),
    liveMode: typeof payment.live_mode === 'boolean' ? payment.live_mode : null,
  };
}
