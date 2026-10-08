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

  // `x-request-id` de MP: identifica la petición del lado de Mercado Pago. Se adjunta
  // SOLO al error (y de ahí al log del servidor); nunca viaja al cliente.
  const mpRequestId = response.headers.get('x-request-id');

  if (!response.ok) {
    throw describeMpError(response.status, payload, { mpRequestId, rawBody: raw });
  }
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
