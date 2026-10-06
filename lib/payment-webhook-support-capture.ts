/**
 * lib/payment-webhook-support-capture.ts — captura TEMPORAL para soporte de MP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ¿PARA QUÉ? (ticket WCS-53484)
 *
 *  Las notificaciones AUTOMÁTICAS (WebHook v1) devuelven 401 `SignatureMismatch`
 *  mientras que el simulador oficial devuelve 200. Soporte de Mercado Pago pidió,
 *  para UN evento automático que falle, los valores EXACTOS que recibe nuestra
 *  ruta: `x-request-id`, `x-signature`, el `data.id` de la query y el manifest
 *  literal `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` que alimenta el HMAC.
 *
 *  Como no hay acceso a los logs de Vercel desde acá, esta captura se escribe como
 *  UNA línea de Runtime Log, habilitada por una variable de entorno SOLO en Preview.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ESTE MÓDULO ES PURO
 *
 *  No toca la base, no llama a Mercado Pago y no lee variables de entorno: recibe
 *  los valores del request y decide. Eso lo hace probable sin red ni DB y garantiza
 *  que la captura NUNCA pueda alterar el resultado del webhook.
 *
 *  ⚠️ TEMPORAL: esta instrumentación debe eliminarse cuando Mercado Pago cierre el
 *  ticket WCS-53484. No persiste ni decide nada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  NO ES UNA SEGUNDA VALIDACIÓN
 *
 *  Acá NO se calcula ningún HMAC ni se compara ninguna firma: el manifest es
 *  EXCLUSIVAMENTE diagnóstico, para mostrarle a soporte qué input recibe el SDK.
 *  La verificación oficial (`WebhookSignatureValidator`) no se toca: una firma
 *  inválida sigue respondiendo HTTP 401.
 */

/**
 * Firma del WebHook v1 AUTOMÁTICO de Mercado Pago.
 *
 * El UA real observado es `MercadoPago WebHook v1.0 payment`. El simulador usa otro
 * (`restclient-node/...`), así que este patrón lo excluye a propósito: solo se
 * captura el caso que falla.
 */
const AUTOMATIC_WEBHOOK_V1_USER_AGENT = /mercadopago\s+webhook\s+v1/i;

/** Nombre EXACTO de la variable que habilita la captura (SOLO Preview). */
export const MP_WEBHOOK_SUPPORT_CAPTURE_ENV = 'MP_WEBHOOK_SUPPORT_CAPTURE';

/** Entrada cruda (efímera) de la captura. Nunca se persiste. */
export interface WebhookSupportCaptureInput {
  /** `process.env.VERCEL_ENV` tal como lo ve la petición. */
  vercelEnv: string | null | undefined;
  /** `process.env.MP_WEBHOOK_SUPPORT_CAPTURE` tal como lo ve la petición. */
  supportCaptureFlag: string | null | undefined;
  /** Momento de recepción fijado por la ruta (ISO 8601). */
  receivedAt: string;
  /** `data.id` (o `id`) tal como vino en el QUERY string. */
  dataIdQuery: string | null | undefined;
  /** Header `x-request-id` CRUDO, sin recortar. */
  xRequestId: string | null | undefined;
  /** Header `x-signature` CRUDO, sin recortar. */
  xSignature: string | null | undefined;
  /** Header `user-agent`. */
  userAgent: string | null | undefined;
}

/** Objeto diagnóstico impreso en Runtime Log. Contiene EXACTAMENTE lo pedido. */
export interface WebhookSupportCaptureRecord {
  receivedAt: string;
  dataIdQuery: string;
  xRequestId: string;
  xSignature: string;
  ts: string | null;
  manifestExact: string;
}

/** ¿El valor existe y no es solo espacios? (para el candado de presencia). */
function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Extrae el `ts` de `x-signature`.
 *
 * Mercado Pago lo manda como `ts=<timestamp>,v1=<hmac>`, con las claves en
 * cualquier orden y con espacios opcionales. Si no viene `ts=`, devuelve `null`.
 */
export function extractSignatureTimestamp(xSignature: string | null | undefined): string | null {
  if (typeof xSignature !== 'string' || xSignature.length === 0) return null;

  for (const part of xSignature.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key !== 'ts') continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }

  return null;
}

/**
 * Construye el manifest EXACTO que se entrega/entregaría al HMAC:
 *
 *     id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 *
 * Diagnóstico puro: no calcula ningún hash.
 */
export function buildSupportManifest(parts: {
  dataIdQuery: string;
  xRequestId: string;
  ts: string | null;
}): string {
  return `id:${parts.dataIdQuery};request-id:${parts.xRequestId};ts:${parts.ts ?? ''};`;
}

/** ¿El user-agent corresponde al WebHook v1 AUTOMÁTICO de Mercado Pago? */
export function isAutomaticWebhookV1UserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && AUTOMATIC_WEBHOOK_V1_USER_AGENT.test(userAgent);
}

/**
 * Decide si corresponde capturar y, en tal caso, arma el objeto diagnóstico.
 *
 * Devuelve `null` —sin efectos— a menos que se cumplan TODAS las condiciones:
 *
 *   1. `VERCEL_ENV === 'preview'` (nunca Production; NO se usa `NODE_ENV`).
 *   2. `MP_WEBHOOK_SUPPORT_CAPTURE === '1'`.
 *   3. user-agent del WebHook v1 AUTOMÁTICO.
 *   4. existe `x-request-id`.
 *   5. existe `x-signature`.
 *   6. existe query param `data.id`.
 *
 * El candado vive ACÁ (no en la ruta): aunque alguien llame a esta función en
 * Production con el flag activado, no hay forma de que devuelva un valor.
 */
export function buildWebhookSupportCapture(
  input: WebhookSupportCaptureInput,
): WebhookSupportCaptureRecord | null {
  // ── Gate de entorno (CONJUNCIÓN, no `NODE_ENV`): imposible en Production ────
  if (input.vercelEnv !== 'preview') return null;
  if (input.supportCaptureFlag !== '1') return null;

  // ── Solo el WebHook v1 AUTOMÁTICO (excluye al simulador) ────────────────────
  if (!isAutomaticWebhookV1UserAgent(input.userAgent)) return null;

  // ── Presencia de los valores que soporte necesita ───────────────────────────
  if (!present(input.dataIdQuery)) return null;
  if (!present(input.xRequestId)) return null;
  if (!present(input.xSignature)) return null;

  const { dataIdQuery, xRequestId, xSignature } = input;

  // Los valores se conservan CRUDOS (raw completo) salvo `data.id`, que se usa tal
  // como lo recibe el SDK (la ruta ya lo normaliza a string recortado).
  const ts = extractSignatureTimestamp(xSignature);

  return {
    receivedAt: input.receivedAt,
    dataIdQuery,
    xRequestId,
    xSignature,
    ts,
    manifestExact: buildSupportManifest({ dataIdQuery, xRequestId, ts }),
  };
}
