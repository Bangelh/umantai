/**
 * lib/payment-webhook-observability.ts — instrumentación NO sensible del webhook.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ¿PARA QUÉ?
 *
 *  Las notificaciones AUTOMÁTICAS de Mercado Pago devuelven 401 mientras que el
 *  simulador oficial, con la MISMA configuración, devuelve 200. La validación de
 *  firma es el `WebhookSignatureValidator` oficial y está correcta, así que lo que
 *  falta es poder comparar los INPUTS que recibió cada notificación.
 *
 *  Como no hay acceso fiable a los logs de Vercel, esos inputs se persisten en la
 *  tabla `payment_webhook_events` (migración 004) y se leen por
 *  `GET /api/debug/payment-webhooks`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ESTE MÓDULO ES PURO
 *
 *  No toca la base, no llama a Mercado Pago y no lee variables de entorno. Solo
 *  transforma lo que llegó en el request (headers, query, body) en un registro de
 *  diagnóstico. Eso lo hace probable sin red ni DB y, sobre todo, garantiza que la
 *  instrumentación NO pueda alterar el resultado del webhook.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA DE ORO: ACÁ NO ENTRA NINGÚN SECRETO
 *
 *   · Nunca se conserva `x-signature` completo, ni el hash `v1`, ni `x-request-id`
 *     completo, ni `MERCADOPAGO_WEBHOOK_SECRET`.
 *   · De esos valores solo quedan PRESENCIA y LONGITUD. Alcanza para diagnosticar
 *     ("el `ts` medía 10 y el `v1` medía 64") sin permitir reconstruir nada.
 */

/** Tope de la lista de nombres de query params. Solo nombres, nunca valores. */
const MAX_QUERY_PARAMS = 30;

/** Longitudes máximas por campo: es metadato de diagnóstico, no dato de negocio. */
const MAX_QUERY_PARAM_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 300;
const MAX_X_RETRY_LENGTH = 80;
const MAX_RESOURCE_ID_LENGTH = 128;
const MAX_TYPE_LENGTH = 64;
const MAX_USER_ID_LENGTH = 64;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

// =============================================================================
//  1. RESUMEN DEL HEADER `x-signature`
// =============================================================================

/** Lo que se puede saber de `x-signature` sin conservar su valor. */
export interface SignatureHeaderSummary {
  /** ¿Vino el header? (no confundir con "es válido"). */
  present: boolean;
  hasTs: boolean;
  hasV1: boolean;
  /** Longitud del valor `ts` (`ts=<...>`), o `null` si no vino. */
  tsLength: number | null;
  /** Longitud del valor `v1` (`v1=<...>`), o `null` si no vino. */
  v1Length: number | null;
}

/**
 * Resume `x-signature` SIN guardar su contenido.
 *
 * Mercado Pago lo manda como `ts=<timestamp>,v1=<hmac>`. Se aceptan claves en
 * cualquier orden y con espacios; si una clave no tiene `=`, se ignora.
 */
export function summarizeSignatureHeader(raw: string | null | undefined): SignatureHeaderSummary {
  const summary: SignatureHeaderSummary = {
    present: typeof raw === 'string' && raw.length > 0,
    hasTs: false,
    hasV1: false,
    tsLength: null,
    v1Length: null,
  };
  if (!summary.present || typeof raw !== 'string') return summary;

  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();

    if (key === 'ts') {
      summary.hasTs = true;
      summary.tsLength = value.length;
    } else if (key === 'v1') {
      summary.hasV1 = true;
      summary.v1Length = value.length;
    }
  }

  return summary;
}

// =============================================================================
//  2. ENTRADA (cruda, efímera) y REGISTRO (persistible)
// =============================================================================

/**
 * Lo que llegó en el request. Contiene valores crudos (¡incluido `x-signature`!),
 * así que vive SOLO en memoria durante el request y NUNCA se loguea ni persiste.
 */
export interface WebhookObservabilityInput {
  pathname: string;
  /** Nombres de los query params presentes (no sus valores). */
  queryParamNames: readonly string[];
  /** `data.id` (o `id`) tal como vino en el query string. */
  queryDataId: string | null;
  /** `data.id` (o `id`) tal como vino en el body JSON. */
  bodyDataId: string | null;
  /** Id resuelto con prioridad query (el que se usa para validar la firma). */
  dataId: string | null;
  queryType: string | null;
  bodyType: string | null;
  action: string | null;
  liveMode: boolean | null;
  userId: string | null;
  xRequestId: string | null;
  xSignature: string | null;
  userAgent: string | null;
  xRetry: string | null;
}

/** Registro derivado: TODO lo que este módulo permite persistir. Sin secretos. */
export interface PaymentWebhookEventRecord {
  pathname: string;
  queryParamNames: string[];
  dataId: string | null;
  queryDataIdPresent: boolean;
  queryDataIdLength: number | null;
  queryDataIdMatchesBody: boolean | null;
  queryType: string | null;
  bodyType: string | null;
  action: string | null;
  liveMode: boolean | null;
  bodyUserId: string | null;
  xRequestIdPresent: boolean;
  xRequestIdLength: number | null;
  xSignaturePresent: boolean;
  signatureHasTs: boolean;
  signatureHasV1: boolean;
  tsLength: number | null;
  v1Length: number | null;
  userAgent: string | null;
  xRetry: string | null;
}

function trimToNull(value: string | null, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncate(trimmed, max) : null;
}

// =============================================================================
//  3. RESULTADO (etiqueta + código HTTP)
// =============================================================================

/** Etiqueta corta y código HTTP que se asocian a un resultado de validación. */
export interface WebhookOutcome {
  result: string;
  httpStatus: number;
}

/**
 * Traduce el resultado de la firma a la etiqueta persistida y al HTTP ESPERADO.
 *
 * Firma inválida → 401 (se conserva el comportamiento original: MP reintenta).
 * Firma válida   → 200 (el resto del flujo decide si termina en 200/500, pero una
 * firma válida nunca es un rechazo). Esta función SOLO describe; la ruta sigue
 * devolviendo 401 por su cuenta cuando la firma no valida.
 */
export function webhookOutcome(signatureOk: boolean, reason?: string | null): WebhookOutcome {
  if (signatureOk) return { result: 'signature_ok', httpStatus: 200 };
  return {
    result: reason ? `invalid_signature:${reason}` : 'invalid_signature',
    httpStatus: 401,
  };
}

/**
 * Deriva el registro persistible a partir de la entrada cruda.
 *
 * Es una función PURA y total: nunca lanza. La usa tanto la ruta (para persistir)
 * como los tests (para comprobar que no filtra secretos).
 */
export function buildWebhookEventRecord(input: WebhookObservabilityInput): PaymentWebhookEventRecord {
  const signature = summarizeSignatureHeader(input.xSignature);
  const xRequestId = trimToNull(input.xRequestId, MAX_RESOURCE_ID_LENGTH);

  const queryParamNames = Array.from(input.queryParamNames ?? [])
    .slice(0, MAX_QUERY_PARAMS)
    .map((name) => truncate(String(name), MAX_QUERY_PARAM_NAME_LENGTH));

  const queryDataId = trimToNull(input.queryDataId, MAX_RESOURCE_ID_LENGTH);
  const bodyDataId = trimToNull(input.bodyDataId, MAX_RESOURCE_ID_LENGTH);

  // Solo se puede COMPARAR cuando el id vino en los dos lados; si falta alguno,
  // `null` (no es lo mismo "no coinciden" que "no hay con qué comparar").
  const queryDataIdMatchesBody =
    queryDataId !== null && bodyDataId !== null ? queryDataId === bodyDataId : null;

  return {
    pathname: truncate(input.pathname ?? '', MAX_RESOURCE_ID_LENGTH),
    queryParamNames,
    dataId: trimToNull(input.dataId, MAX_RESOURCE_ID_LENGTH),
    queryDataIdPresent: queryDataId !== null,
    queryDataIdLength: queryDataId !== null ? queryDataId.length : null,
    queryDataIdMatchesBody,
    queryType: trimToNull(input.queryType, MAX_TYPE_LENGTH),
    bodyType: trimToNull(input.bodyType, MAX_TYPE_LENGTH),
    action: trimToNull(input.action, MAX_TYPE_LENGTH),
    liveMode: typeof input.liveMode === 'boolean' ? input.liveMode : null,
    bodyUserId: trimToNull(input.userId, MAX_USER_ID_LENGTH),
    xRequestIdPresent: xRequestId !== null,
    xRequestIdLength: xRequestId !== null ? xRequestId.length : null,
    xSignaturePresent: signature.present,
    signatureHasTs: signature.hasTs,
    signatureHasV1: signature.hasV1,
    tsLength: signature.tsLength,
    v1Length: signature.v1Length,
    userAgent: trimToNull(input.userAgent, MAX_USER_AGENT_LENGTH),
    xRetry: trimToNull(input.xRetry, MAX_X_RETRY_LENGTH),
  };
}
