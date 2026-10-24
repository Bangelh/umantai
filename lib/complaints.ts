/**
 * lib/complaints.ts — Libro de Reclamaciones: dominio puro.
 *
 * Sin DB, sin Next, sin Resend. Acá viven:
 *   · los tipos y límites del formulario;
 *   · la validación server-side (la que decide, no el HTML);
 *   · el cálculo del plazo de respuesta de 15 días hábiles;
 *   · el formato del número correlativo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PLAZO — LIMITACIÓN CONOCIDA
 *
 *  Se cuentan 15 días hábiles desde el día siguiente a la presentación, en hora
 *  de Lima (UTC-5), excluyendo SÁBADO y DOMINGO.
 *
 *  NO se excluyen feriados nacionales porque el proyecto no tiene un calendario
 *  confiable. Antes del lanzamiento público hay que reemplazar
 *  `PERU_HOLIDAYS` por el calendario oficial del año o aceptar por escrito que
 *  el vencimiento puede caer en feriado (se respondería el mismo día o antes).
 *  Está documentado en LIBRO_RECLAMACIONES.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  SEGURIDAD: los errores son CÓDIGOS, no textos. La UI los traduce y el
 *  servidor nunca devuelve DNI, teléfono ni correo en una respuesta pública.
 */

export const COMPLAINT_KINDS = ['reclamo', 'queja'] as const;
export type ComplaintKind = (typeof COMPLAINT_KINDS)[number];

export const COMPLAINT_STATUSES = ['received', 'in_review', 'answered'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/** Plazo legal: 15 días hábiles improrrogables. */
export const COMPLAINT_RESPONSE_BUSINESS_DAYS = 15;

/** Zona horaria de referencia para el cómputo. Lima no tiene horario de verano. */
export const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Feriados nacionales de Perú.
 *
 * VACÍO A PROPÓSITO: no se inventan fechas. Ver la limitación documentada
 * arriba y en LIBRO_RECLAMACIONES.md antes de publicar.
 */
export const PERU_HOLIDAYS: readonly string[] = [];

export const COMPLAINT_LIMITS = {
  nameMin: 2,
  nameMax: 120,
  documentMin: 6,
  documentMax: 20,
  phoneMin: 6,
  phoneMax: 25,
  emailMax: 254,
  relatedItemMin: 2,
  relatedItemMax: 200,
  detailMin: 20,
  detailMax: 4000,
  requestMin: 10,
  requestMax: 2000,
  /** S/ 1 000 000,00 — tope defensivo, no una regla de negocio. */
  amountCentsMax: 100_000_000,
  /** Tamaño máximo del cuerpo JSON aceptado por la API. */
  bodyMaxBytes: 32_000,
  /** Respuesta del proveedor (texto plano). */
  responseMin: 5,
  responseMax: 4000,
  actionsMax: 2000,
} as const;

export interface ComplaintResponseInput {
  responseText: string;
  providerActions: string | null;
}

export type ComplaintResponseValidation =
  | { ok: true; value: ComplaintResponseInput }
  | { ok: false; errors: Partial<Record<'responseText' | 'providerActions', ComplaintErrorCode>> };

/** Valida la respuesta del proveedor (solo Platform Admin). */
export function validateComplaintResponse(raw: unknown): ComplaintResponseValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: { responseText: 'required' } };
  }
  const body = raw as Record<string, unknown>;
  const errors: Partial<Record<'responseText' | 'providerActions', ComplaintErrorCode>> = {};

  const responseText = multiLine(body.responseText);
  if (!responseText) errors.responseText = 'required';
  else if (responseText.length < COMPLAINT_LIMITS.responseMin) errors.responseText = 'too_short';
  else if (responseText.length > COMPLAINT_LIMITS.responseMax) errors.responseText = 'too_long';

  const providerActions = multiLine(body.providerActions);
  if (providerActions.length > COMPLAINT_LIMITS.actionsMax) {
    errors.providerActions = 'too_long';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { responseText, providerActions: providerActions || null },
  };
}

export type ComplaintField =
  | 'kind'
  | 'consumerName'
  | 'consumerDocument'
  | 'consumerPhone'
  | 'consumerEmail'
  | 'guardianName'
  | 'guardianDocument'
  | 'relatedItem'
  | 'amountCents'
  | 'detail'
  | 'consumerRequest'
  | 'consent';

export type ComplaintErrorCode =
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'invalid'
  | 'invalid_email'
  | 'invalid_phone'
  | 'invalid_document'
  | 'invalid_amount'
  | 'guardian_required';

export type ComplaintErrors = Partial<Record<ComplaintField, ComplaintErrorCode>>;

export interface ComplaintInput {
  kind: ComplaintKind;
  consumerName: string;
  consumerDocument: string;
  consumerPhone: string;
  consumerEmail: string;
  isMinor: boolean;
  guardianName: string | null;
  guardianDocument: string | null;
  relatedItem: string;
  amountCents: number | null;
  detail: string;
  consumerRequest: string;
}

export type ComplaintValidation =
  | { ok: true; value: ComplaintInput }
  | { ok: false; errors: ComplaintErrors; spam?: boolean };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOCUMENT_PATTERN = /^[A-Z0-9-]{6,20}$/;
const PHONE_PATTERN = /^[+()\d\s.-]+$/;
const AMOUNT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
/** Código público: base64url de 24 caracteres (144 bits). Nunca secuencial. */
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Quita controles invisibles y colapsa espacios en campos de una línea. */
function singleLine(value: unknown): string {
  return asString(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Conserva saltos de línea, quita controles y limita líneas vacías. */
function multiLine(value: unknown): string {
  return asString(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAmountCents(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };

  let units: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false };
    units = value;
  } else if (typeof value === 'string') {
    const normalized = value.trim().replace(',', '.');
    if (!AMOUNT_PATTERN.test(normalized)) return { ok: false };
    units = Number(normalized);
  } else {
    return { ok: false };
  }

  const cents = Math.round(units * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > COMPLAINT_LIMITS.amountCentsMax) {
    return { ok: false };
  }
  return { ok: true, value: cents };
}

function isValidKind(value: string): value is ComplaintKind {
  return (COMPLAINT_KINDS as readonly string[]).includes(value);
}

/** Código público bien formado (no implica que exista). */
export function isValidPublicCode(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_CODE_PATTERN.test(value);
}

export function isComplaintKind(value: unknown): value is ComplaintKind {
  return typeof value === 'string' && (COMPLAINT_KINDS as readonly string[]).includes(value);
}

export function isComplaintStatus(value: unknown): value is ComplaintStatus {
  return typeof value === 'string' && (COMPLAINT_STATUSES as readonly string[]).includes(value);
}

/**
 * Validación server-side. Normaliza antes de guardar y devuelve códigos de
 * error por campo; nunca confía en el HTML ni en el orden de los campos.
 */
export function validateComplaintPayload(raw: unknown): ComplaintValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: { kind: 'invalid' } };
  }

  const body = raw as Record<string, unknown>;

  // Honeypot: respuesta neutra para no revelarle al bot qué campo lo delató.
  if (singleLine(body.company).length > 0) {
    return { ok: false, errors: {}, spam: true };
  }

  const errors: ComplaintErrors = {};

  const kind = singleLine(body.kind).toLowerCase();
  if (!isValidKind(kind)) errors.kind = 'invalid';

  const consumerName = singleLine(body.consumerName);
  if (!consumerName) errors.consumerName = 'required';
  else if (consumerName.length < COMPLAINT_LIMITS.nameMin) errors.consumerName = 'too_short';
  else if (consumerName.length > COMPLAINT_LIMITS.nameMax) errors.consumerName = 'too_long';

  const consumerDocument = singleLine(body.consumerDocument)
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!consumerDocument) errors.consumerDocument = 'required';
  else if (
    consumerDocument.length < COMPLAINT_LIMITS.documentMin ||
    consumerDocument.length > COMPLAINT_LIMITS.documentMax ||
    !DOCUMENT_PATTERN.test(consumerDocument)
  ) {
    errors.consumerDocument = 'invalid_document';
  }

  const consumerPhone = singleLine(body.consumerPhone);
  if (!consumerPhone) errors.consumerPhone = 'required';
  else if (
    consumerPhone.length < COMPLAINT_LIMITS.phoneMin ||
    consumerPhone.length > COMPLAINT_LIMITS.phoneMax ||
    !PHONE_PATTERN.test(consumerPhone)
  ) {
    errors.consumerPhone = 'invalid_phone';
  }

  const consumerEmail = singleLine(body.consumerEmail).toLowerCase();
  if (!consumerEmail) errors.consumerEmail = 'required';
  else if (consumerEmail.length > COMPLAINT_LIMITS.emailMax || !EMAIL_PATTERN.test(consumerEmail)) {
    errors.consumerEmail = 'invalid_email';
  }

  const isMinor = body.isMinor === true;
  let guardianName: string | null = null;
  let guardianDocument: string | null = null;

  if (isMinor) {
    guardianName = singleLine(body.guardianName);
    guardianDocument = singleLine(body.guardianDocument).replace(/\s+/g, '').toUpperCase();

    if (
      guardianName.length < COMPLAINT_LIMITS.nameMin ||
      guardianName.length > COMPLAINT_LIMITS.nameMax
    ) {
      errors.guardianName = guardianName ? 'invalid' : 'guardian_required';
    }
    if (
      guardianDocument.length < COMPLAINT_LIMITS.documentMin ||
      guardianDocument.length > COMPLAINT_LIMITS.documentMax ||
      !DOCUMENT_PATTERN.test(guardianDocument)
    ) {
      errors.guardianDocument = guardianDocument ? 'invalid_document' : 'guardian_required';
    }
  }

  const relatedItem = singleLine(body.relatedItem);
  if (!relatedItem) errors.relatedItem = 'required';
  else if (relatedItem.length < COMPLAINT_LIMITS.relatedItemMin) errors.relatedItem = 'too_short';
  else if (relatedItem.length > COMPLAINT_LIMITS.relatedItemMax) errors.relatedItem = 'too_long';

  const amount = parseAmountCents(body.amountCents);
  if (!amount.ok) errors.amountCents = 'invalid_amount';

  const detail = multiLine(body.detail);
  if (!detail) errors.detail = 'required';
  else if (detail.length < COMPLAINT_LIMITS.detailMin) errors.detail = 'too_short';
  else if (detail.length > COMPLAINT_LIMITS.detailMax) errors.detail = 'too_long';

  const consumerRequest = multiLine(body.consumerRequest);
  if (!consumerRequest) errors.consumerRequest = 'required';
  else if (consumerRequest.length < COMPLAINT_LIMITS.requestMin) errors.consumerRequest = 'too_short';
  else if (consumerRequest.length > COMPLAINT_LIMITS.requestMax) errors.consumerRequest = 'too_long';

  if (body.consent !== true) errors.consent = 'required';

  if (Object.keys(errors).length > 0 || !isValidKind(kind) || !amount.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      kind,
      consumerName,
      consumerDocument,
      consumerPhone,
      consumerEmail,
      isMinor,
      guardianName,
      guardianDocument,
      relatedItem,
      amountCents: amount.value,
      detail,
      consumerRequest,
    },
  };
}

// =============================================================================
//  PLAZO
// =============================================================================

/** Fecha local de Lima como día UTC (para operar con getUTC*). */
function limaCalendarDate(date: Date): Date {
  return new Date(date.getTime() - LIMA_OFFSET_MS);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isBusinessDay(date: Date): boolean {
  const weekday = date.getUTCDay(); // 0 domingo, 6 sábado
  if (weekday === 0 || weekday === 6) return false;
  return !PERU_HOLIDAYS.includes(isoDay(date));
}

/**
 * Suma días hábiles empezando SIEMPRE por el día siguiente. Devuelve el final de
 * ese día en hora de Lima (23:59:59), expresado en UTC.
 */
export function addBusinessDaysLima(start: Date, businessDays: number): Date {
  if (!Number.isFinite(start.getTime())) throw new Error('Fecha inicial inválida');
  const days = Math.max(0, Math.trunc(businessDays));

  const cursor = limaCalendarDate(start);
  let year = cursor.getUTCFullYear();
  let month = cursor.getUTCMonth();
  let day = cursor.getUTCDate();
  let remaining = days;

  while (remaining > 0) {
    day += 1;
    const probe = new Date(Date.UTC(year, month, day));
    year = probe.getUTCFullYear();
    month = probe.getUTCMonth();
    day = probe.getUTCDate();
    if (isBusinessDay(probe)) remaining -= 1;
  }

  // 23:59:59 en Lima = 04:59:59 UTC del día siguiente.
  return new Date(Date.UTC(year, month, day, 23, 59, 59) + LIMA_OFFSET_MS);
}

/** Fecha límite de respuesta para una presentación dada. */
export function complaintDueAt(submittedAt: Date): Date {
  return addBusinessDaysLima(submittedAt, COMPLAINT_RESPONSE_BUSINESS_DAYS);
}

/** ¿Sigue pendiente y ya venció? (una respuesta cerrada nunca está vencida). */
export function isComplaintOverdue(
  status: ComplaintStatus,
  dueAt: Date | string,
  now: Date = new Date(),
): boolean {
  if (status === 'answered') return false;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}

/** `RC-000123`. Correlativo visible; no sirve para consultar sin el código. */
export function formatComplaintNumber(value: number | bigint | string): string {
  const digits = String(value).replace(/\D/g, '').padStart(6, '0');
  return `RC-${digits}`;
}
