import { NextResponse } from 'next/server';

import {
  isComplaintKind,
  isComplaintStatus,
  type ComplaintKind,
  type ComplaintStatus,
} from '@/lib/complaints';
import {
  isComplaintsStorageConfigured,
  listComplaints,
} from '@/lib/complaints.server';
import { requireActivePlatformAdminSession } from '@/lib/platform-admin.server';
import {
  PERU_HOLIDAY_CALENDAR_VERSION,
  peruHolidayCalendarYears,
} from '@/lib/peru-holidays';

/**
 * GET /api/admin/complaints — bandeja del Libro de Reclamaciones.
 *
 * SOLO Platform Admin con cookie firmada y rol vigente: la cookie se revalida
 * contra `platform_admins` en cada petición, así que revocar el rol corta el
 * acceso de inmediato. No acepta `x-admin-token`: acá se leen DNI, teléfonos y
 * correos, así que el token de automatización no alcanza.
 *
 * Filtros: ?status=received|in_review|answered · ?kind=reclamo|queja
 *          ?from=YYYY-MM-DD · ?to=YYYY-MM-DD (sobre submitted_at) · ?limit=1..200
 *
 * Respuesta: { ok, complaints: ComplaintAdminView[], generatedAt }.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  const access = await requireActivePlatformAdminSession(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, code: access.code, error: access.message },
      { status: access.status, headers: NO_STORE },
    );
  }

  if (!isComplaintsStorageConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
      { status: 503, headers: NO_STORE },
    );
  }

  const url = new URL(request.url);

  const rawStatus = url.searchParams.get('status');
  let status: ComplaintStatus | null = null;
  if (rawStatus) {
    if (!isComplaintStatus(rawStatus)) {
      return NextResponse.json(
        { ok: false, code: 'invalid_status', error: 'status no es válido.' },
        { status: 400, headers: NO_STORE },
      );
    }
    status = rawStatus;
  }

  const rawKind = url.searchParams.get('kind');
  let kind: ComplaintKind | null = null;
  if (rawKind) {
    if (!isComplaintKind(rawKind)) {
      return NextResponse.json(
        { ok: false, code: 'invalid_kind', error: 'kind no es válido.' },
        { status: 400, headers: NO_STORE },
      );
    }
    kind = rawKind;
  }

  const rawFrom = url.searchParams.get('from');
  if (rawFrom && !validDate(rawFrom)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_from', error: 'from debe ser YYYY-MM-DD.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const rawTo = url.searchParams.get('to');
  if (rawTo && !validDate(rawTo)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_to', error: 'to debe ser YYYY-MM-DD.' },
      { status: 400, headers: NO_STORE },
    );
  }

  if (rawFrom && rawTo && rawFrom > rawTo) {
    return NextResponse.json(
      { ok: false, code: 'invalid_range', error: 'from no puede ser posterior a to.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const rawLimit = url.searchParams.get('limit');
  let limit = 100;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return NextResponse.json(
        { ok: false, code: 'invalid_limit', error: 'limit debe ser un entero entre 1 y 200.' },
        { status: 400, headers: NO_STORE },
      );
    }
    limit = parsed;
  }

  try {
    const complaints = await listComplaints({ status, kind, from: rawFrom, to: rawTo, limit });
    return NextResponse.json(
      {
        ok: true,
        complaints,
        calendar: {
          version: PERU_HOLIDAY_CALENDAR_VERSION,
          configuredYears: peruHolidayCalendarYears(),
        },
        generatedAt: new Date().toISOString(),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[reclamaciones] no se pudo listar', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      { ok: false, code: 'complaints_list_failed', error: 'No se pudo cargar la bandeja.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
