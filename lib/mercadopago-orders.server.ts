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
 *  · Lee SOLO cuatro variables, con lectura EXPLÍCITA de `process.env`:
 *        MP_ORDERS_ACCESS_TOKEN
 *        MP_ORDERS_WEBHOOK_SECRET
 *        MP_ORDERS_BACK_URL_BASE
 *        MP_ORDERS_QA_PAYER_EMAIL   (email REAL de la cuenta de prueba comprador)
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
 * Variable con el email del comprador de la orden QA.
 *
 * ─── POR QUÉ NO HAY UN DEFAULT ──────────────────────────────────────────────
 *  La doc oficial de Checkout Pro vía Orders (`integration-test-introduction`) es
 *  explícita: *"Asegúrate de incluir como email del pagador el correo electrónico de
 *  la cuenta de prueba comprador"*. Un email inventado que solo cumple el formato
 *  `@testuser.com` (el que exige `invalid_email_for_sandbox`) hace que la order se cree
 *  igual —201 + `checkout_url`— pero el checkout HOSPEDADO no puede resolver al
 *  comprador y muestra un error genérico.
 *
 *  Por eso el valor viene SIEMPRE de esta variable: no hay placeholder por defecto,
 *  no se acepta desde el body del cliente y, si falta, el creador falla cerrado
 *  (`mp_orders_qa_payer_email_missing`) en vez de inventar un comprador.
 */
export const MP_ORDERS_QA_PAYER_EMAIL_ENV = 'MP_ORDERS_QA_PAYER_EMAIL';

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

/**
 * Email REAL de la cuenta de prueba comprador. Cadena vacía si no está configurada.
 *
 * Solo se usa server-side: nunca se loguea, nunca se devuelve en una respuesta y
 * nunca se expone en un endpoint de diagnóstico (ahí solo se publica si EXISTE).
 */
export function getMpOrdersQaPayerEmail(): string {
  // Se lee por LITERAL (no por la constante) para que el test de aislamiento pueda
  // comprobar, leyendo el código, exactamente qué variables consulta este módulo.
  return readExactEnv('MP_ORDERS_QA_PAYER_EMAIL');
}

/** ¿Tenemos el comprador QA configurado? Si no, la creación falla cerrada (503). */
export function isMpOrdersQaPayerEmailConfigured(): boolean {
  return getMpOrdersQaPayerEmail().length > 0;
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

/** Un pago de `transactions.payments`, reducido a lo NO sensible. */
export interface MpOrdersOrderPaymentView {
  id: string | null;
  status: string | null;
  statusDetail: string | null;
  amount: string | null;
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

  // ─── CAMPOS AÑADIDOS PARA LA INSPECCIÓN QA (SOLO LECTURA) ──────────────────
  //
  // Los usa `GET /api/admin/qa/mp-orders/[orderId]` para poder MIRAR una Order ya
  // creada sin abrir una segunda vía de acceso a la API de Orders: salen de la
  // MISMA respuesta del GET que esta función ya hacía, así que no hay petición
  // extra y el flujo del webhook sigue leyendo exactamente lo de siempre.
  //
  // Nada de esto es un secreto: no hay tokens, ni la URL completa de checkout, ni
  // el email del comprador (solo su forma enmascarada).

  /** HTTP status REAL de la respuesta de MP (200 cuando la Order se pudo leer). */
  httpStatus: number;
  /**
   * `x-request-id` de MP: identifica la petición del lado de Mercado Pago (soporte).
   * NO es un secreto. El webhook no lo devuelve al cliente: solo lo usa la ruta QA.
   */
  mpRequestId: string | null;
  createdDate: string | null;
  lastUpdatedDate: string | null;
  expirationTime: string | null;
  countryCode: string | null;
  currency: string | null;
  /** `live_mode` de la Order: `false` significa orden de PRUEBA. `null` si MP no lo manda. */
  liveMode: boolean | null;
  /** Todo booleano de primer nivel que hable de modo (`live_mode`, `sandbox`, …). */
  modeFlags: Record<string, boolean>;
  /** ¿La respuesta trae `checkout_url`? La URL COMPLETA nunca se devuelve. */
  checkoutUrlPresent: boolean;
  /** Host de `checkout_url` (sin path ni query). `null` si no hay o no es absoluta. */
  checkoutUrlHost: string | null;
  /** `config.online` reducido a datos NO sensibles (hosts de back_urls y flags). */
  configOnline: Record<string, string | boolean> | null;
  payerId: string | null;
  /** Email del comprador ENMASCARADO (`c***@te***.com`). Nunca el valor completo. */
  payerEmailMasked: string | null;
  payments: MpOrdersOrderPaymentView[];
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

/**
 * Modo del ítem dentro del payload de creación. SOLO diagnóstico controlado.
 *
 *  · `minimal`    → `{ title, unit_price, quantity }`.
 *  · `documented` → añade `unit_measure` y `total_amount`, exactamente como los
 *                   muestra la guía oficial de `Create order` para Checkout Pro.
 *
 * Existe porque hay una inconsistencia histórica SIN ATRIBUIR: en su momento Mercado
 * Pago respondió `unsupported_properties` con `field: null` y nunca se supo qué
 * propiedad sobraba. Con los dos modos se puede replicar primero el payload mínimo
 * (el que sí funcionó) y, solo si crea la orden, comparar el documentado, midiendo la
 * MISMA respuesta de MP. No es una opción pública: la ruta que la expone es
 * administrativa y solo corre fuera de Producción.
 */
export type MpOrdersItemPayloadMode = 'minimal' | 'documented';

/** Modo por defecto: el mínimo que ya creó órdenes con éxito. */
export const DEFAULT_MP_ORDERS_ITEM_PAYLOAD_MODE: MpOrdersItemPayloadMode = 'minimal';

/** Ítem en el modo `minimal`. */
export interface MpOrdersMinimalItem {
  title: string;
  unit_price: string;
  quantity: number;
}

/** Ítem en el modo `documented` (la guía oficial incluye `unit_measure`/`total_amount`). */
export interface MpOrdersDocumentedItem extends MpOrdersMinimalItem {
  unit_measure: string;
  total_amount: string;
}

/** Ítem de la orden ya armado, según el modo elegido. */
export type MpOrdersItemBody = MpOrdersMinimalItem | MpOrdersDocumentedItem;

/** Body de `POST /v1/orders` en la forma exacta que documenta la referencia. */
export interface MpOrdersCreateBody {
  type: 'online';
  processing_mode: 'manual';
  total_amount: string;
  external_reference: string;
  payer: { email: string };
  items: MpOrdersItemBody[];
  config?: {
    online: {
      success_url: string;
      failure_url: string;
      pending_url: string;
      /**
       * Redirección automática. La doc (`configure-back-urls`) exige que, si se usa,
       * se envíe `success_url` en la misma solicitud: acá van siempre juntas.
       */
      auto_return: 'approved';
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
 *
 * `auto_return: "approved"` se añade SOLO acá, donde ya existe una `success_url`
 * válida: la doc (`configure-back-urls`) documenta `auto_return` con los valores
 * `approved`/`all` y exige `success_url` en la misma solicitud. Es el único campo
 * nuevo: no se agregan campos arbitrarios.
 *
 * PENDIENTE (decisión de negocio, NO implementado): `expiration_time` de la order
 * (la doc acepta ISO 8601, p. ej. `P1D`). No se envía hasta alinear la expiración de
 * la order con la reserva de stock de UMANTAI, para que la order no siga viva cuando
 * el inventario ya se liberó (o al revés).
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
      auto_return: 'approved',
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
 *   · `payer.email` es obligatorio dentro de `payer` y debe ser el de la cuenta de
 *     prueba comprador: acá NO hay default, si falta se falla cerrado.
 *
 * `payloadMode` (`minimal` por defecto, `documented` a pedido) decide si cada ítem
 * lleva solo `{ title, unit_price, quantity }` o además `unit_measure`/`total_amount`
 * como en la guía oficial. Es una palanca de DIAGNÓSTICO, no una opción pública.
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
  payloadMode?: MpOrdersItemPayloadMode;
}): MpOrdersCreateBody {
  const externalReference = input.externalReference.trim();
  if (!externalReference) throw new MpOrdersValidationError('external_reference_required');
  // La doc acota `external_reference` a 64 caracteres.
  if (externalReference.length > 64) throw new MpOrdersValidationError('external_reference_too_long');

  // Sin comprador QA configurado NO se inventa uno: es el error que la ruta traduce
  // a un 503 explícito (`mp_orders_qa_payer_email_missing`).
  const payerEmail = input.payerEmail.trim();
  if (!payerEmail) throw new MpOrdersValidationError('mp_orders_qa_payer_email_missing');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
    throw new MpOrdersValidationError('payer_email_invalid');
  }

  if (input.items.length === 0) throw new MpOrdersValidationError('items_required');

  const payloadMode = input.payloadMode ?? DEFAULT_MP_ORDERS_ITEM_PAYLOAD_MODE;

  let totalCents = 0;
  const items: MpOrdersItemBody[] = input.items.map((item) => {
    const title = item.title.trim();
    if (!title) throw new MpOrdersValidationError('item_title_required');

    const unitCents = parseAmountToCents(item.unitPrice);
    if (unitCents === null) throw new MpOrdersValidationError('item_unit_price_invalid');
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new MpOrdersValidationError('item_quantity_invalid');
    }

    const itemTotalCents = unitCents * item.quantity;
    totalCents += itemTotalCents;

    const minimal: MpOrdersMinimalItem = {
      title,
      unit_price: formatCents(unitCents),
      quantity: item.quantity,
    };

    if (payloadMode === 'minimal') return minimal;

    return {
      ...minimal,
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
  /** Propiedad/`path` que MP señala como ofensora, si la informa. */
  readonly field: string | null;
  /** `x-request-id` de MP: identifica la petición del lado de MP (soporte). */
  readonly mpRequestId: string | null;
  /**
   * Resumen sanitizado y acotado del campo `details` de MP (el que acompaña a
   * `unsupported_properties`), o `null` si MP no lo mandó. Va SOLO al log.
   */
  readonly mpDetails: string | null;

  constructor(
    httpStatus: number,
    mpCode: string | null,
    message: string,
    options: { field?: string | null; mpRequestId?: string | null; mpDetails?: string | null } = {},
  ) {
    super(message);
    this.name = 'MpOrdersApiError';
    this.httpStatus = httpStatus;
    this.mpCode = mpCode;
    this.field = options.field ?? null;
    this.mpRequestId = options.mpRequestId ?? null;
    this.mpDetails = options.mpDetails ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  OBSERVABILIDAD DEL ERROR DE MP (sanitizada)
//
//  Mercado Pago NO usa una sola forma de error: puede mandar `code`/`error`/`message`
//  en la raíz, o anidar el detalle en `errors[...]` (la documentación oficial dice
//  "Check the errors field for more information") o en `cause[...]`. Mirando solo la
//  raíz, cualquier 4xx quedaba como `mp_request_failed` sin ninguna pista.
//
//  Ahora se reconocen las tres formas y SIEMPRE se devuelve un resultado acotado y
//  sin secretos. El cuerpo completo nunca se conserva ni se devuelve al cliente.
//
//  Caso aparte: `unsupported_properties` ("Properties not supported") no dice CUÁL
//  propiedad sobra en `code`/`message` — hay que mirar `details`, que la doc oficial
//  manda revisar. `details` tampoco tiene forma fija (array, objeto o anidado), así
//  que se resume en `mpDetails`, acotado y sanitizado, solo para el log.
// ─────────────────────────────────────────────────────────────────────────────

/** Máximo de caracteres que se conservan de un mensaje/snippet de error. */
export const MP_ERROR_SNIPPET_MAX = 300;

/**
 * Máximo de caracteres del resumen sanitizado de `details`.
 *
 * `details` puede crecer mucho (una entrada por propiedad ofensora); se acota para
 * no inundar el log ni arrastrar el cuerpo completo de la respuesta.
 */
export const MP_ERROR_DETAILS_MAX = 500;

/** Entradas de `details` que se resumen (las demás se descartan). */
const MP_ERROR_DETAILS_MAX_ENTRIES = 3;

/** Niveles de anidamiento de `details` que se recorren. */
const MP_ERROR_DETAILS_MAX_DEPTH = 2;

/** Campos anidados de una entrada de `details` que vale la pena seguir. */
const MP_ERROR_DETAILS_NESTED_KEYS = ['details', 'errors', 'cause'] as const;

/** Tope de un valor suelto dentro de `details` (`details[].value`). */
const MP_ERROR_DETAILS_VALUE_MAX = 160;

/** Máximo para un campo corto del error (código de MP, `path`, `x-request-id`). */
const MP_ERROR_SHORT_FIELD_MAX = 120;

/** Credenciales con prefijo de Mercado Pago: `APP_USR-…`, `TEST-…`. */
const MP_TOKEN_PREFIX_PATTERN = /\b(?:APP_USR|APP|TEST|TEST-USER)[-_][A-Za-z0-9._~+/=-]{6,}/gi;

/** `Authorization: Bearer …` que alguna capa intermedia pudiera repetir en el error. */
const BEARER_PATTERN = /\bBearer\s+\S+/gi;

/** JWT suelto (`eyJ…`). */
const JWT_PATTERN = /\beyJ[A-Za-z0-9._-]{10,}/g;

/** Pares `access_token=…` / `"refresh_token": "…"` que pudieran aparecer en texto. */
const TOKEN_PAIR_PATTERN =
  /((?:['"]?)(?:access|refresh|id|client)_token(?:['"]?)\s*[:=]\s*)(?:['"]?)([^\s'",}]{4,})/gi;

/**
 * Redacta tokens reconocibles y aplana caracteres de control (CR/LF repetidos).
 *
 * No recorta longitud: eso lo decide quien la usa, porque los campos cortos y los
 * snippets tienen topes distintos.
 */
function redactSensitiveText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(BEARER_PATTERN, '[redacted]')
    .replace(MP_TOKEN_PREFIX_PATTERN, '[redacted]')
    .replace(JWT_PATTERN, '[redacted]')
    .replace(TOKEN_PAIR_PATTERN, (_match, prefix: string) => `${prefix}[redacted]`);
}

/** Recorta, aplana y redacta un texto de error. `null` si queda vacío. */
function safeText(value: string | null | undefined, max: number): string | null {
  const string = asNonEmptyString(value);
  if (!string) return null;
  const safe = redactSensitiveText(string).replace(/\s+/g, ' ').trim();
  return safe ? safe.slice(0, max) : null;
}

/** Campo corto y seguro (código de MP, `path`, `x-request-id`). */
function safeShortField(value: string | null | undefined): string | null {
  return safeText(value, MP_ERROR_SHORT_FIELD_MAX);
}

/**
 * Snippet seguro de un cuerpo de error que NO es JSON.
 *
 * Es lo ÚNICO que se conserva del cuerpo: una línea, con secretos redactados y
 * acotado a `MP_ERROR_SNIPPET_MAX` caracteres. Se usa solo para el log del
 * servidor; jamás se devuelve al cliente.
 */
export function sanitizeMpErrorSnippet(raw: string): string {
  return redactSensitiveText(raw).replace(/\s+/g, ' ').trim().slice(0, MP_ERROR_SNIPPET_MAX);
}

/** Campos que puede traer una entrada de `errors[]`/`cause[]`. */
interface MpErrorEntry {
  code: string | null;
  message: string | null;
  field: string | null;
}

/** Extrae lo poco que interesa de UNA entrada de error, sin asumir su forma. */
function readErrorEntry(value: unknown): MpErrorEntry | null {
  const record = asRecord(value);
  if (!record) return null;

  const code = safeShortField(asNonEmptyString(record.code) ?? asNonEmptyString(record.error));
  const message =
    asNonEmptyString(record.message) ??
    asNonEmptyString(record.detail) ??
    asNonEmptyString(record.description) ??
    asNonEmptyString(record.error);
  const field = safeShortField(
    asNonEmptyString(record.path) ??
      asNonEmptyString(record.field) ??
      asNonEmptyString(record.parameter) ??
      asNonEmptyString(record.param),
  );

  if (!code && !message && !field) return null;
  return { code, message, field };
}

/** Primera entrada de una colección: sea array (`[0]`) u objeto suelto. */
function firstRawEntry(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Primera entrada de `errors`/`cause`: sea array (`errors[0]`) u objeto suelto. */
function firstErrorEntry(value: unknown): MpErrorEntry | null {
  return readErrorEntry(firstRawEntry(value));
}

/** String de un escalar (`details[].value` puede venir como número o booleano). */
function asScalarString(value: unknown): string | null {
  if (typeof value === 'string') return asNonEmptyString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * `details[].value`: se conserva SOLO si no contiene nada sensible.
 *
 * Si la redacción cambia el texto (token `APP_USR-`/`TEST-`, `Bearer`, JWT,
 * `access_token=…`) o el valor es demasiado largo para ser un dato de error, se
 * descarta ENTERO: es preferible perder el valor antes que registrar un secreto
 * parcialmente redactado.
 */
function safeDetailsValue(value: unknown): string | null {
  const raw = asScalarString(value);
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed || collapsed.length > MP_ERROR_DETAILS_VALUE_MAX) return null;
  if (redactSensitiveText(collapsed) !== collapsed) return null;
  return collapsed;
}

/** Pares `campo=valor` de UNA entrada de `details`, ya acotados y redactados. */
function readDetailsEntry(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];

  const code = safeShortField(asNonEmptyString(record.code) ?? asNonEmptyString(record.error));
  const field = safeShortField(
    asNonEmptyString(record.path) ??
      asNonEmptyString(record.field) ??
      asNonEmptyString(record.parameter) ??
      asNonEmptyString(record.param) ??
      asNonEmptyString(record.property),
  );
  const message = safeText(
    asNonEmptyString(record.message) ??
      asNonEmptyString(record.detail) ??
      asNonEmptyString(record.description) ??
      asNonEmptyString(record.error),
    MP_ERROR_DETAILS_VALUE_MAX,
  );
  // `property` es el nombre exacto de la propiedad que MP no soporta; si coincide
  // con el `path` ya elegido no se repite.
  const property = safeShortField(asNonEmptyString(record.property));
  const detailValue = safeDetailsValue(record.value);

  const parts: string[] = [];
  if (code) parts.push(`code=${code}`);
  if (field) parts.push(`field=${field}`);
  if (property && property !== field) parts.push(`property=${property}`);
  if (message) parts.push(`message=${message}`);
  if (detailValue) parts.push(`value=${detailValue}`);
  return parts;
}

/**
 * Último recurso para un `details` con campos que no conocemos: se registran SOLO
 * los NOMBRES de las claves de la primera entrada (nunca valores), para no perder
 * la pista ni filtrar contenido.
 */
function describeUnknownDetails(value: unknown): string | null {
  const record = asRecord(firstRawEntry(value));
  if (!record) {
    return Array.isArray(value) && value.length > 0 ? `array(${value.length})` : null;
  }
  const keys = Object.keys(record).slice(0, 12);
  return keys.length > 0 ? `keys=${keys.join(',')}` : null;
}

/**
 * Resumen sanitizado y acotado del campo `details` de MP.
 *
 * MP lo usa para señalar la propiedad no soportada (`unsupported_properties`) y la
 * doc oficial pide revisarlo, pero su forma no es fija: puede ser un array, un objeto,
 * o traer otro `details`/`errors`/`cause` anidado. Acá se recorren esas variantes con
 * tope de entradas y de profundidad, y NUNCA se vuelca el cuerpo completo. El
 * resultado va SOLO al log del servidor (la respuesta al cliente sigue sanitizada).
 */
export function summarizeMpErrorDetails(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const entries = Array.isArray(value) ? value : [value];
  const summaries: string[] = [];

  const walk = (node: unknown, depth: number): void => {
    if (summaries.length >= MP_ERROR_DETAILS_MAX_ENTRIES || depth > MP_ERROR_DETAILS_MAX_DEPTH) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (summaries.length >= MP_ERROR_DETAILS_MAX_ENTRIES) return;
        walk(item, depth);
      }
      return;
    }
    const record = asRecord(node);
    if (!record) return;

    const parts = readDetailsEntry(record);
    if (parts.length > 0) summaries.push(parts.join(' '));

    for (const key of MP_ERROR_DETAILS_NESTED_KEYS) {
      const child = record[key];
      if (child !== null && child !== undefined) walk(child, depth + 1);
    }
  };

  for (const entry of entries) {
    if (summaries.length >= MP_ERROR_DETAILS_MAX_ENTRIES) break;
    walk(entry, 0);
  }

  const summary = summaries.length > 0 ? summaries.join(' | ') : describeUnknownDetails(value);
  if (!summary) return null;

  const safe = redactSensitiveText(summary).replace(/\s+/g, ' ').trim();
  if (!safe) return null;
  return safe.length > MP_ERROR_DETAILS_MAX
    ? `${safe.slice(0, MP_ERROR_DETAILS_MAX - 1)}…`
    : safe;
}

/**
 * Describe un error de MP SIN arrastrar el cuerpo completo.
 *
 * Orden de reconocimiento:
 *   · raíz: `code`, `error` (si es string), `message`;
 *   · `errors[0]`: `code`, `message`/`detail`/`description`, `path`/`field`;
 *   · `cause[0]`: `code`, `message`/`description`, `path`/`field`;
 *   · `details` (raíz, o dentro de `errors[0]`/`cause[0]`): resumido en `mpDetails`
 *     cuando el código por sí solo no dice qué propiedad es la ofensora.
 *
 * Si el cuerpo NO era JSON se agrega un snippet acotado (`mp_request_failed: …`),
 * que va SOLO al log del servidor (la ruta responde su mensaje genérico). Si era
 * JSON pero sin ningún código reconocible se registran únicamente los NOMBRES de
 * las claves de primer nivel: nunca valores.
 */
function describeMpError(
  status: number,
  payload: unknown,
  context: { mpRequestId?: string | null; rawBody?: string | null } = {},
): MpOrdersApiError {
  const record = asRecord(payload);
  const topCode = safeShortField(asNonEmptyString(record?.code) ?? asNonEmptyString(record?.error));
  const topMessage = asNonEmptyString(record?.message) ?? asNonEmptyString(record?.error);
  const nested = firstErrorEntry(record?.errors) ?? firstErrorEntry(record?.cause);

  const code = topCode ?? nested?.code ?? null;
  const field = nested?.field ?? null;
  const message = safeText(topMessage, MP_ERROR_SNIPPET_MAX) ?? safeText(nested?.message, MP_ERROR_SNIPPET_MAX);

  // `unsupported_properties` no nombra la propiedad en `code`/`message`: vive en
  // `details`, que puede venir en la raíz o dentro de `errors[0]`/`cause[0]`.
  const detailsValue =
    record?.details ??
    asRecord(firstRawEntry(record?.errors))?.details ??
    asRecord(firstRawEntry(record?.cause))?.details;
  const mpDetails = summarizeMpErrorDetails(detailsValue);

  let detail: string;
  if (code || message) {
    detail = `${code ?? 'error'}: ${message ?? ''}`;
  } else if (payload === null) {
    const snippet = context.rawBody ? sanitizeMpErrorSnippet(context.rawBody) : '';
    detail = snippet ? `mp_request_failed: ${snippet}` : 'mp_request_failed';
  } else {
    const keys = record ? Object.keys(record).slice(0, 12).join(',') : 'non_object';
    detail = `mp_request_failed: json_keys=${keys}`;
  }

  return new MpOrdersApiError(status, code, detail, {
    field,
    mpRequestId: safeShortField(context.mpRequestId),
    mpDetails,
  });
}

/** Lo que `mpFetch` conserva de la respuesta: estado, `x-request-id` y cuerpo crudo. */
interface MpFetchResult {
  status: number;
  requestId: string | null;
  payload: unknown;
}

async function mpFetch(
  path: string,
  init: RequestInit,
  accessToken: string,
): Promise<MpFetchResult> {
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

  // `x-request-id` de MP: identifica la petición del lado de Mercado Pago. Se adjunta
  // SOLO al error (y de ahí al log del servidor); nunca viaja al cliente.
  const mpRequestId = response.headers.get('x-request-id');

  if (!response.ok) {
    throw describeMpError(response.status, payload, { mpRequestId, rawBody: raw });
  }
  return { status: response.status, requestId: mpRequestId, payload };
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
  const { payload } = await mpFetch(
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

// ─────────────────────────────────────────────────────────────────────────────
//  VISTA SANITIZADA DE UNA ORDER EXISTENTE (pura, sin red)
//
//  Lo que consume la ruta QA de inspección. Se calcula SIEMPRE sobre la respuesta
//  del mismo GET: nunca se pide nada más a Mercado Pago y nunca sale de acá un dato
//  sensible (token, URL completa de checkout, email completo, headers).
// ─────────────────────────────────────────────────────────────────────────────

/** Caracteres de la parte local del email que se conservan antes del `***`. */
const EMAIL_LOCAL_MASK_VISIBLE = 1;

/** Caracteres del dominio que se conservan antes del `***`. */
const EMAIL_DOMAIN_MASK_VISIBLE = 2;

/** Tope de un valor suelto de `config.online` que no sea URL. */
const CONFIG_ONLINE_VALUE_MAX = 120;

/** Claves de modo que se publican como booleanos (`live_mode`, `sandbox`, …). */
const MODE_FLAG_PATTERN = /(live|sandbox|test)/i;

/**
 * Enmascara un email conservando lo mínimo para reconocerlo: `test@testuser.com`
 * → `t***@te***.com`. Nunca se devuelve el valor completo.
 *
 * Recibe `unknown` a propósito: la entrada viene del payload de Mercado Pago (puede
 * no ser un string) y acá se sanitiza en vez de confiar en la forma.
 */
export function maskEmail(value: unknown): string | null {
  const email = asNonEmptyString(value);
  if (!email) return null;

  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';

  const local = maskEmailSegment(email.slice(0, at), EMAIL_LOCAL_MASK_VISIBLE);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const label = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';

  return `${local}@${maskEmailSegment(label, EMAIL_DOMAIN_MASK_VISIBLE)}${tld}`;
}

/** Primeros `visible` caracteres de un segmento + `***` (nunca el segmento entero). */
function maskEmailSegment(segment: string, visible: number): string {
  const chars = [...segment];
  if (chars.length === 0) return '***';
  const shown = Math.min(visible, Math.max(1, chars.length - 1));
  return `${chars.slice(0, shown).join('')}***`;
}

/** Host de una URL absoluta; `null` si el valor no es una URL válida. */
function urlHostOf(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * Reduce `config.online` a datos NO sensibles.
 *
 * · Un valor que sea URL absoluta se publica SOLO como host: la URL completa puede
 *   llevar query con identificadores y no hace falta para diagnosticar.
 * · Los booleanos se conservan tal cual (son flags de configuración).
 * · Cualquier otro valor se acota; si la redacción lo cambia (olor a credencial) se
 *   descarta entero.
 *
 * Acepta el objeto con o sin el envoltorio `config.online`.
 */
export function sanitizeMpOrdersConfigOnline(
  value: unknown,
): Record<string, string | boolean> | null {
  const online = asRecord(asRecord(value)?.online) ?? asRecord(value);
  if (!online) return null;

  const safe: Record<string, string | boolean> = {};
  for (const [key, raw] of Object.entries(online)) {
    if (typeof raw === 'boolean') {
      safe[key] = raw;
      continue;
    }
    const text = asScalarString(raw);
    if (!text) continue;
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;

    const host = urlHostOf(collapsed);
    if (host) {
      safe[key] = host;
      continue;
    }
    if (collapsed.length > CONFIG_ONLINE_VALUE_MAX) continue;
    if (redactSensitiveText(collapsed) !== collapsed) continue;
    safe[key] = collapsed;
  }

  return Object.keys(safe).length > 0 ? safe : null;
}

/** Booleanos de primer nivel que hablan del modo de la orden (test/live/sandbox). */
function collectModeFlags(record: Record<string, unknown> | null): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  if (!record) return flags;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'boolean' && MODE_FLAG_PATTERN.test(key)) flags[key] = value;
  }
  return flags;
}

/**
 * Pagos de `transactions.payments`, ya sanitizados.
 *
 * Si el campo no es un array se devuelve una lista vacía: es lo mismo que veía el
 * webhook (que solo miraba el primer elemento de un array).
 */
function readPaymentViews(value: unknown): MpOrdersOrderPaymentView[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const payment = asRecord(entry);
    return {
      id: asScalarString(payment?.id),
      status: asNonEmptyString(payment?.status),
      statusDetail: asNonEmptyString(payment?.status_detail),
      amount: asScalarString(payment?.amount) ?? asScalarString(payment?.total_paid_amount),
    };
  });
}

/**
 * Consulta una orden por id (`GET /v1/orders/{id}`).
 *
 * Este es el recurso correcto tras el webhook del tópico `order`: el `data.id` que
 * llega ES un id de Order, y la doc recomienda este GET para completar los datos.
 * NO se usa `Payment.get` (eso es la semántica de la integración vieja).
 *
 * La MISMA respuesta alimenta dos lecturas: los campos que necesita el webhook
 * (los de siempre) y la vista sanitizada de inspección que expone la ruta QA. Así
 * no existe una segunda ruta de acceso a la API de Orders ni una petición extra.
 */
export async function fetchMpOrdersOrder(options: {
  orderId: string;
  accessToken: string;
}): Promise<MpOrdersOrderSnapshot> {
  const result = await mpFetch(
    `/v1/orders/${encodeURIComponent(options.orderId)}`,
    { method: 'GET' },
    options.accessToken,
  );

  const record = asRecord(result.payload);
  const integrationData = asRecord(record?.integration_data);
  const payer = asRecord(record?.payer);
  const payments = readPaymentViews(asRecord(record?.transactions)?.payments);
  const checkoutUrl = asNonEmptyString(record?.checkout_url);

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
    paymentStatus: payments[0]?.status ?? null,
    paymentStatusDetail: payments[0]?.statusDetail ?? null,

    httpStatus: result.status,
    mpRequestId: result.requestId,
    createdDate: asNonEmptyString(record?.created_date) ?? asNonEmptyString(record?.date_created),
    lastUpdatedDate:
      asNonEmptyString(record?.last_updated_date) ?? asNonEmptyString(record?.last_updated),
    expirationTime: asNonEmptyString(record?.expiration_time),
    countryCode: asNonEmptyString(record?.country_code),
    currency: asNonEmptyString(record?.currency) ?? asNonEmptyString(record?.currency_id),
    liveMode: typeof record?.live_mode === 'boolean' ? record.live_mode : null,
    modeFlags: collectModeFlags(record),
    checkoutUrlPresent: checkoutUrl !== null,
    checkoutUrlHost: checkoutUrl ? urlHostOf(checkoutUrl) : null,
    configOnline: sanitizeMpOrdersConfigOnline(record?.config),
    payerId: asScalarString(payer?.id),
    payerEmailMasked: maskEmail(payer?.email),
    payments,
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
