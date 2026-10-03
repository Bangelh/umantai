/**
 * lib/mercadopago-identity.server.ts — diagnóstico de IDENTIDAD de Mercado Pago.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PARA QUÉ SIRVE
 *
 *  El webhook de Mercado Pago devuelve 401 (`SignatureMismatch`) a las
 *  notificaciones AUTOMÁTICAS reales de Preview, mientras el simulador oficial
 *  devuelve 200. La hipótesis principal es que el `MERCADOPAGO_ACCESS_TOKEN` con
 *  el que se CREÓ la preferencia no pertenece a la MISMA aplicación cuyo
 *  `MERCADOPAGO_WEBHOOK_SECRET` usamos para validar la firma (app distinta, o
 *  mezcla de credenciales de prueba/producción).
 *
 *  Para comprobarlo sin copiar ni exponer el token, este módulo consulta SOLO
 *  endpoints READ-ONLY oficiales con el token del servidor y devuelve una
 *  proyección SANITIZADA (identificadores y metadatos públicos, nada sensible):
 *
 *    · GET /users/me                          → identidad del vendedor/token
 *    · GET /checkout/preferences/{id}         → identidad de la Preference
 *    · GET /v1/payments/{id}                  → identidad del pago
 *
 *  NUNCA se devuelve: el access token, el webhook secret, cabeceras de
 *  autorización, el body crudo de MP, email/DNI/nombre/dirección/teléfono del
 *  comprador, ni datos de tarjeta. Los sanitizadores seleccionan campos por
 *  allowlist (nunca se reenvía el objeto crudo).
 *
 *  INYECCIÓN: `fetchImpl` permite testear sin red. El orquestador es puro respecto
 *  a la red (todo pasa por `fetchImpl`).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Base de la API pública de Mercado Pago. */
export const MP_API_BASE = 'https://api.mercadopago.com';

/** Timeout por request; MP responde rápido pero no queremos colgar la función. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Tope defensivo del tamaño de los mensajes de error que reenviamos. */
const MAX_REASON_LENGTH = 200;

/** Tope del identificador de recurso aceptado (preference/payment id). */
const MAX_RESOURCE_ID_LENGTH = 64;

// =============================================================================
//  1. TIPOS DE SALIDA (proyección SANITIZADA)
// =============================================================================

/** Identidad del vendedor dueño del token (`GET /users/me`). */
export interface SanitizedMpUser {
  id: number | null;
  siteId: string | null;
  countryId: string | null;
  nickname: string | null;
}

/** Identidad de una Preference (`GET /checkout/preferences/{id}`). */
export interface SanitizedMpPreference {
  id: string | null;
  collectorId: number | null;
  clientId: string | null;
  externalReference: string | null;
  notificationUrl: string | null;
  hasInitPoint: boolean;
  hasSandboxInitPoint: boolean;
  liveMode: boolean | null;
  applicationId: string | null;
}

/** Identidad de un pago (`GET /v1/payments/{id}`). */
export interface SanitizedMpPayment {
  id: string | null;
  status: string | null;
  statusDetail: string | null;
  externalReference: string | null;
  liveMode: boolean | null;
  collectorId: number | null;
  applicationId: string | null;
  sponsorId: string | null;
  transactionAmount: number | null;
  currencyId: string | null;
  paymentMethodId: string | null;
  paymentTypeId: string | null;
}

/** Resultado de una consulta: éxito con datos o fallo diagnosticado. */
export type MpSection<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; reason: string };

/** Reporte completo de identidad (lo que devuelve el endpoint). */
export interface MercadoPagoIdentityReport {
  generatedAt: string;
  user: MpSection<SanitizedMpUser>;
  preference: MpSection<SanitizedMpPreference> | null;
  payment: MpSection<SanitizedMpPayment> | null;
}

export interface MercadoPagoIdentityRequest {
  preferenceId?: string | null;
  paymentId?: string | null;
}

export interface MercadoPagoIdentityDeps {
  /** Token de acceso del SERVIDOR. Nunca se devuelve ni se loguea. */
  accessToken: string;
  /** Inyectable para tests (sin red). Por defecto `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Timeout por request en ms. */
  timeoutMs?: number;
}

// =============================================================================
//  2. HELPERS DE SANITIZACIÓN (allowlist por campo)
// =============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asIdString(value: unknown): string | null {
  if (typeof value === 'string') return asString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function hasNonEmptyString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `nickname` es público, pero podría ser un email en algunas cuentas: si contiene
 * `@` lo descartamos, para no exponer un contacto del vendedor.
 */
function safeNickname(value: unknown): string | null {
  const nickname = asString(value);
  if (!nickname) return null;
  if (nickname.includes('@')) return null;
  return nickname;
}

export function sanitizeMpUser(raw: unknown): SanitizedMpUser {
  const r = asRecord(raw) ?? {};
  return {
    id: asNumber(r.id),
    siteId: asString(r.site_id),
    countryId: asString(r.country_id),
    nickname: safeNickname(r.nickname),
  };
}

export function sanitizeMpPreference(raw: unknown): SanitizedMpPreference {
  const r = asRecord(raw) ?? {};
  return {
    id: asIdString(r.id),
    collectorId: asNumber(r.collector_id),
    clientId: asString(r.client_id),
    externalReference: asString(r.external_reference),
    notificationUrl: asString(r.notification_url),
    hasInitPoint: hasNonEmptyString(r, 'init_point'),
    hasSandboxInitPoint: hasNonEmptyString(r, 'sandbox_init_point'),
    liveMode: asBoolean(r.live_mode),
    applicationId: asString(r.application_id),
  };
}

export function sanitizeMpPayment(raw: unknown): SanitizedMpPayment {
  const r = asRecord(raw) ?? {};
  return {
    id: asIdString(r.id),
    status: asString(r.status),
    statusDetail: asString(r.status_detail),
    externalReference: asString(r.external_reference),
    liveMode: asBoolean(r.live_mode),
    collectorId: asNumber(r.collector_id),
    applicationId: asString(r.application_id),
    sponsorId: asString(r.sponsor_id),
    transactionAmount: asNumber(r.transaction_amount),
    currencyId: asString(r.currency_id),
    paymentMethodId: asString(r.payment_method_id),
    paymentTypeId: asString(r.payment_type_id),
  };
}

// =============================================================================
//  3. VALIDACIÓN Y SANITIZACIÓN DE MENSAJES DE ERROR
// =============================================================================

/**
 * Identificador de recurso aceptado: alfanumérico con `-` y `_`. Devuelve `null`
 * si está vacío o excede el tope (así la ruta responde 400 sin mandarlo a MP).
 */
export function normalizeResourceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RESOURCE_ID_LENGTH) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Elimina cualquier rastro de secretos de un texto libre de MP: reemplaza el token
 * (y cualquier patrón `Bearer ...`) y colapsa cadenas opacas largas.
 */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]');
  // Tokens/hashes opacos largos (base64/hex) que pudieran colarse.
  out = out.replace(/\b[A-Za-z0-9._\-]{40,}\b/g, '[redacted]');
  return out.length > MAX_REASON_LENGTH ? `${out.slice(0, MAX_REASON_LENGTH)}…` : out;
}

/** Etiqueta estable y NO sensible para un status HTTP de MP. */
function statusLabel(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'upstream_error' : 'upstream_error';
  }
}

/**
 * Construye un motivo sanitizado a partir de la respuesta de error de MP.
 *
 * Solo se conserva `error`/`message` (texto corto), redactado contra secretos. El
 * body crudo NUNCA se reenvía.
 */
async function sanitizedUpstreamReason(response: Response, secrets: string[]): Promise<string> {
  const label = statusLabel(response.status);
  let detail = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        detail = asString(parsed.error) ?? asString(parsed.message) ?? '';
      } catch {
        detail = '';
      }
    }
  } catch {
    detail = '';
  }
  const safeDetail = detail ? redactSecrets(detail, secrets) : '';
  return safeDetail ? `${label}: ${safeDetail}` : label;
}

/** Clasifica un fallo de red/timeout sin filtrar detalles del error. */
function classifyTransportError(error: unknown): string {
  const name = (error as { name?: string } | null | undefined)?.name;
  if (name === 'AbortError') return 'timeout';
  return 'network_error';
}

// =============================================================================
//  4. LLAMADAS READ-ONLY A MP
// =============================================================================

interface ResolvedDeps {
  accessToken: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: string[];
}

function resolveDeps(deps: MercadoPagoIdentityDeps): ResolvedDeps {
  return {
    accessToken: deps.accessToken,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    timeoutMs: deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS,
    secrets: [deps.accessToken],
  };
}

async function getJson(
  url: string,
  deps: ResolvedDeps,
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const response = await deps.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${deps.accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: await sanitizedUpstreamReason(response, deps.secrets),
      };
    }

    const body = (await response.json()) as unknown;
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, reason: classifyTransportError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function loadUser(deps: ResolvedDeps): Promise<MpSection<SanitizedMpUser>> {
  const result = await getJson(`${MP_API_BASE}/users/me`, deps);
  if (!result.ok) return { ok: false, status: result.status, reason: result.reason };
  return { ok: true, status: result.status, data: sanitizeMpUser(result.body) };
}

async function loadPreference(
  preferenceId: string,
  deps: ResolvedDeps,
): Promise<MpSection<SanitizedMpPreference>> {
  const result = await getJson(
    `${MP_API_BASE}/checkout/preferences/${encodeURIComponent(preferenceId)}`,
    deps,
  );
  if (!result.ok) return { ok: false, status: result.status, reason: result.reason };
  return { ok: true, status: result.status, data: sanitizeMpPreference(result.body) };
}

async function loadPayment(
  paymentId: string,
  deps: ResolvedDeps,
): Promise<MpSection<SanitizedMpPayment>> {
  const result = await getJson(`${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, deps);
  if (!result.ok) return { ok: false, status: result.status, reason: result.reason };
  return { ok: true, status: result.status, data: sanitizeMpPayment(result.body) };
}

// =============================================================================
//  5. ORQUESTADOR
// =============================================================================

/**
 * Consulta la identidad del token y, opcionalmente, la de la Preference y el pago.
 * Las tres consultas son independientes (se corren en paralelo) y READ-ONLY.
 */
export async function collectMercadoPagoIdentity(
  request: MercadoPagoIdentityRequest,
  deps: MercadoPagoIdentityDeps,
): Promise<MercadoPagoIdentityReport> {
  const resolved = resolveDeps(deps);
  const preferenceId = normalizeResourceId(request.preferenceId);
  const paymentId = normalizeResourceId(request.paymentId);

  const [user, preference, payment] = await Promise.all([
    loadUser(resolved),
    preferenceId ? loadPreference(preferenceId, resolved) : Promise.resolve(null),
    paymentId ? loadPayment(paymentId, resolved) : Promise.resolve(null),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    user,
    preference,
    payment,
  };
}
