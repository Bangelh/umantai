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
 */

import { MercadoPagoConfig, Preference } from 'mercadopago';
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

  const origin = options.origin.replace(/\/+$/, '');
  const backUrl = (flag: 'exitoso' | 'pendiente' | 'fallido') =>
    `${origin}/pedido/${order.publicToken}?pago=${flag}`;

  // MP exige `back_urls` en HTTPS para poder usar `auto_return`; en local (http)
  // omitimos `auto_return` en vez de comerse un 400 del API.
  const isHttps = origin.startsWith('https://');

  const statementDescriptor = readEnv('MERCADOPAGO_STATEMENT_DESCRIPTOR');

  const body = {
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
    notification_url: `${origin}/api/payments/webhook`,
    metadata: {
      order_id: order.id,
      order_number: order.orderNumber,
      public_token: order.publicToken,
    },
    ...(statementDescriptor ? { statement_descriptor: statementDescriptor } : {}),
  };

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
    createdAt: new Date().toISOString(),
  };
}
