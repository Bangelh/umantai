import { NextResponse } from 'next/server';

import { validateComplaintResponse } from '@/lib/complaints';
import {
  answerComplaint,
  getComplaintById,
  isComplaintsStorageConfigured,
  markComplaintInReview,
} from '@/lib/complaints.server';
import { sendComplaintResponse } from '@/lib/complaints-email.server';
import { getPlatformAdminLabel, requirePlatformAdminSession } from '@/lib/platform-admin.server';

/**
 * GET   /api/admin/complaints/:id — detalle (Platform Admin).
 * PATCH /api/admin/complaints/:id — { action: 'start_review' } |
 *                                    { action: 'answer', responseText, providerActions? }
 *
 * NO existe DELETE: las hojas de reclamación son evidencia y deben conservarse.
 * Una respuesta ya emitida no se sobrescribe (409).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 12_000;

interface RouteContext {
  params: Promise<{ id: string }>;
}

type Gate =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

function gate(request: Request): Gate {
  const access = requirePlatformAdminSession(request);
  if (!access.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, code: access.code, error: access.message },
        { status: access.status, headers: NO_STORE },
      ),
    };
  }
  if (!isComplaintsStorageConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
        { status: 503, headers: NO_STORE },
      ),
    };
  }
  return { ok: true, userId: access.userId };
}

export async function GET(request: Request, context: RouteContext) {
  const access = gate(request);
  if (!access.ok) return access.response;

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_id', error: 'Identificador inválido.' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const complaint = await getComplaintById(id);
    if (!complaint) {
      return NextResponse.json(
        { ok: false, code: 'complaint_not_found', error: 'No existe esa reclamación.' },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json({ ok: true, complaint }, { headers: NO_STORE });
  } catch (error) {
    console.error('[reclamaciones] no se pudo leer el detalle', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      { ok: false, code: 'complaint_read_failed', error: 'No se pudo cargar la reclamación.' },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const access = gate(request);
  if (!access.ok) return access.response;
  const actor = await getPlatformAdminLabel(access.userId);

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_id', error: 'Identificador inválido.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, code: 'payload_too_large', error: 'La respuesta es demasiado larga.' },
      { status: 413, headers: NO_STORE },
    );
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { ok: false, code: 'payload_too_large', error: 'La respuesta es demasiado larga.' },
        { status: 413, headers: NO_STORE },
      );
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'No pudimos leer la solicitud.' },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'No pudimos leer la solicitud.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const body = raw as Record<string, unknown>;
  const action = body.action;

  try {
    const current = await getComplaintById(id);
    if (!current) {
      return NextResponse.json(
        { ok: false, code: 'complaint_not_found', error: 'No existe esa reclamación.' },
        { status: 404, headers: NO_STORE },
      );
    }
    if (current.status === 'answered') {
      return NextResponse.json(
        {
          ok: false,
          code: 'complaint_already_answered',
          error: 'Esta reclamación ya fue atendida. El historial no se sobrescribe.',
        },
        { status: 409, headers: NO_STORE },
      );
    }

    if (action === 'start_review') {
      const updated = await markComplaintInReview(id, actor);
      return NextResponse.json({ ok: true, complaint: updated ?? current }, { headers: NO_STORE });
    }

    if (action !== 'answer') {
      return NextResponse.json(
        { ok: false, code: 'invalid_action', error: 'Acción no válida.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const validation = validateComplaintResponse(body);
    if (!validation.ok) {
      return NextResponse.json(
        { ok: false, code: 'invalid_response', errors: validation.errors },
        { status: 400, headers: NO_STORE },
      );
    }

    const updated = await answerComplaint(id, validation.value, new Date(), actor);
    if (!updated) {
      return NextResponse.json(
        {
          ok: false,
          code: 'complaint_already_answered',
          error: 'Esta reclamación ya fue atendida. El historial no se sobrescribe.',
        },
        { status: 409, headers: NO_STORE },
      );
    }

    const emailStatus = await sendComplaintResponse({
      complaintNumber: updated.complaintNumber,
      publicCode: updated.publicCode,
      kind: updated.kind,
      consumerEmail: updated.consumerEmail,
      consumerName: updated.consumerName,
      dueAt: updated.dueAt,
      responseText: updated.responseText ?? validation.value.responseText,
    });

    return NextResponse.json({ ok: true, complaint: updated, emailStatus }, { headers: NO_STORE });
  } catch (error) {
    console.error('[reclamaciones] no se pudo actualizar', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      { ok: false, code: 'complaint_update_failed', error: 'No se pudo actualizar la reclamación.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
