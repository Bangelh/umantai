/**
 * lib/complaints.server.ts — persistencia del Libro de Reclamaciones.
 *
 * SOLO SERVIDOR. La API pública no devuelve PII: la consulta por código entrega
 * número, estado, fechas, motivo y respuesta. DNI, teléfono y correo quedan
 * únicamente en la vista de Platform Admin.
 *
 * El registro se guarda ANTES de intentar cualquier correo. Si Resend está
 * apagado, la constancia se muestra igual y el correo queda `not_configured`.
 *
 * No hay borrado: el historial debe poder acreditarse ante INDECOPI.
 */

import { randomBytes } from 'node:crypto';

import { createSqlClient, type SqlClient } from './db-driver.server';
import { getDatabaseUrl } from './db';
import {
  complaintDueAt,
  formatComplaintNumber,
  type ComplaintInput,
  type ComplaintKind,
  type ComplaintStatus,
} from './complaints';

export interface ComplaintCreated {
  id: string;
  /** Correlativo visible: RC-000001. */
  complaintNumber: string;
  /** Código aleatorio para constancia/seguimiento. */
  publicCode: string;
  submittedAt: string;
  dueAt: string;
}

export interface ComplaintPublicView {
  complaintNumber: string;
  kind: ComplaintKind;
  status: ComplaintStatus;
  relatedItem: string;
  amountCents: number | null;
  currency: string;
  detail: string;
  consumerRequest: string;
  providerActions: string | null;
  responseText: string | null;
  submittedAt: string;
  dueAt: string;
  respondedAt: string | null;
  /** `true` si sigue pendiente y la fecha límite ya pasó. */
  overdue: boolean;
}

export interface ComplaintAdminView extends ComplaintPublicView {
  id: string;
  publicCode: string;
  consumerName: string;
  consumerDocument: string;
  consumerPhone: string;
  consumerEmail: string;
  isMinor: boolean;
  guardianName: string | null;
  guardianDocument: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplaintListFilters {
  status?: ComplaintStatus | null;
  kind?: ComplaintKind | null;
  /** YYYY-MM-DD sobre `submitted_at`. */
  from?: string | null;
  to?: string | null;
  limit?: number;
}

let cachedSql: SqlClient | null = null;

function getComplaintSql(): SqlClient | null {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedSql) cachedSql = createSqlClient(url);
  return cachedSql;
}

export function isComplaintsStorageConfigured(): boolean {
  return !!getDatabaseUrl();
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapPublic(row: Record<string, unknown>): ComplaintPublicView {
  const dueAt = toIso(row.due_at) ?? new Date().toISOString();
  const status = String(row.status) as ComplaintStatus;
  return {
    complaintNumber: formatComplaintNumber(String(row.complaint_number)),
    kind: String(row.kind) as ComplaintKind,
    status,
    relatedItem: String(row.related_item),
    amountCents: toNumberOrNull(row.amount_cents),
    currency: String(row.currency ?? 'PEN'),
    detail: String(row.detail),
    consumerRequest: String(row.consumer_request),
    providerActions: row.provider_actions === null ? null : String(row.provider_actions),
    responseText: row.response_text === null ? null : String(row.response_text),
    submittedAt: toIso(row.submitted_at) ?? dueAt,
    dueAt,
    respondedAt: toIso(row.responded_at),
    overdue: status !== 'answered' && new Date(dueAt).getTime() < Date.now(),
  };
}

function mapAdmin(row: Record<string, unknown>): ComplaintAdminView {
  return {
    ...mapPublic(row),
    id: String(row.id),
    publicCode: String(row.public_code),
    consumerName: String(row.consumer_name),
    consumerDocument: String(row.consumer_document),
    consumerPhone: String(row.consumer_phone),
    consumerEmail: String(row.consumer_email),
    isMinor: row.is_minor === true,
    guardianName: row.guardian_name === null ? null : String(row.guardian_name),
    guardianDocument: row.guardian_document === null ? null : String(row.guardian_document),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Genera 144 bits de entropía en base64url. No es secuencial y no deriva del
 * correlativo: sin el código no se puede adivinar ni enumerar una constancia.
 */
export function generatePublicCode(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Registra el reclamo/queja. Calcula `due_at` en el servidor (nunca se acepta
 * una fecha del navegador) y devuelve el correlativo y el código de seguimiento.
 */
export async function createComplaint(
  input: ComplaintInput,
  submittedAt: Date = new Date(),
): Promise<ComplaintCreated> {
  const sql = getComplaintSql();
  if (!sql) throw new Error('complaints_storage_unavailable');

  // Se recalcula acá también para que un llamador no pueda imponer un plazo.
  const dueAt = complaintDueAt(submittedAt);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const publicCode = generatePublicCode();
    try {
      const rows = await sql`
        INSERT INTO consumer_complaints (
          public_code, kind,
          consumer_name, consumer_document, consumer_phone, consumer_email,
          is_minor, guardian_name, guardian_document,
          related_item, amount_cents, currency,
          detail, consumer_request,
          submitted_at, due_at
        ) VALUES (
          ${publicCode}, ${input.kind},
          ${input.consumerName}, ${input.consumerDocument}, ${input.consumerPhone}, ${input.consumerEmail},
          ${input.isMinor}, ${input.guardianName}, ${input.guardianDocument},
          ${input.relatedItem}, ${input.amountCents}, 'PEN',
          ${input.detail}, ${input.consumerRequest},
          ${submittedAt.toISOString()}::timestamptz, ${dueAt.toISOString()}::timestamptz
        )
        RETURNING id, complaint_number, public_code, submitted_at, due_at
      `;

      const row = rows[0];
      if (!row) throw new Error('complaints_insert_empty');
      return {
        id: String(row.id),
        complaintNumber: formatComplaintNumber(String(row.complaint_number)),
        publicCode: String(row.public_code),
        submittedAt: toIso(row.submitted_at) ?? submittedAt.toISOString(),
        dueAt: toIso(row.due_at) ?? dueAt.toISOString(),
      };
    } catch (error) {
      lastError = error;
      // Colisión de `public_code` (prácticamente imposible): se reintenta.
      if (isUniqueViolation(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('complaints_insert_failed');
}

/** Consulta pública por código. Sin código válido no se toca la base. */
export async function getComplaintByPublicCode(code: string): Promise<ComplaintPublicView | null> {
  const sql = getComplaintSql();
  if (!sql) return null;

  const rows = await sql`
    SELECT complaint_number, kind, status, related_item, amount_cents, currency,
           detail, consumer_request, provider_actions, response_text,
           submitted_at, due_at, responded_at
      FROM consumer_complaints
     WHERE public_code = ${code}
     LIMIT 1
  `;
  return rows[0] ? mapPublic(rows[0]) : null;
}

/** Vista de Platform Admin: incluye los datos de contacto necesarios. */
export async function getComplaintById(id: string): Promise<ComplaintAdminView | null> {
  const sql = getComplaintSql();
  if (!sql) return null;

  const rows = await sql`
    SELECT * FROM consumer_complaints WHERE id = ${id}::uuid LIMIT 1
  `;
  return rows[0] ? mapAdmin(rows[0]) : null;
}

/** Listado con filtros. `limit` se acota en la ruta (1..200). */
export async function listComplaints(filters: ComplaintListFilters = {}): Promise<ComplaintAdminView[]> {
  const sql = getComplaintSql();
  if (!sql) return [];

  const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit ?? 100)));
  const status = filters.status ?? null;
  const kind = filters.kind ?? null;
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  const rows = await sql`
    SELECT * FROM consumer_complaints
     WHERE (${status}::text IS NULL OR status = ${status}::text)
       AND (${kind}::text IS NULL OR kind = ${kind}::text)
       AND (${from}::date IS NULL OR submitted_at >= ${from}::date)
       AND (${to}::date IS NULL OR submitted_at < (${to}::date + INTERVAL '1 day'))
     ORDER BY submitted_at DESC
     LIMIT ${limit}
  `;
  return rows.map(mapAdmin);
}

/** Pasa un reclamo recibido a "en revisión". Idempotente. */
export async function markComplaintInReview(id: string): Promise<ComplaintAdminView | null> {
  const sql = getComplaintSql();
  if (!sql) return null;

  const rows = await sql`
    UPDATE consumer_complaints
       SET status = 'in_review', updated_at = NOW()
     WHERE id = ${id}::uuid AND status = 'received'
     RETURNING *
  `;
  if (rows[0]) return mapAdmin(rows[0]);
  return getComplaintById(id);
}

/**
 * Registra la respuesta del proveedor y marca el reclamo como atendido.
 * No permite sobrescribir una respuesta ya emitida (el historial es prueba).
 * Devuelve `null` si la base no está o si ya estaba respondido.
 */
export async function answerComplaint(
  id: string,
  response: { responseText: string; providerActions?: string | null },
  respondedAt: Date = new Date(),
): Promise<ComplaintAdminView | null> {
  const sql = getComplaintSql();
  if (!sql) return null;

  const actions = response.providerActions?.trim() ? response.providerActions.trim() : null;

  const rows = await sql`
    UPDATE consumer_complaints
       SET status = 'answered',
           response_text = ${response.responseText},
           provider_actions = COALESCE(${actions}, provider_actions, ${response.responseText}),
           responded_at = ${respondedAt.toISOString()}::timestamptz,
           updated_at = NOW()
     WHERE id = ${id}::uuid AND status <> 'answered'
     RETURNING *
  `;
  return rows[0] ? mapAdmin(rows[0]) : null;
}

/** Solo para diagnóstico/tests: no se expone en la API pública. */
export async function countComplaints(): Promise<number> {
  const sql = getComplaintSql();
  if (!sql) return 0;
  const rows = await sql`SELECT COUNT(*)::text AS total FROM consumer_complaints`;
  return Number(rows[0]?.total ?? 0);
}
