import { NextResponse } from 'next/server';

import {
  COMPLAINT_LIMITS,
  validateComplaintPayload,
} from '@/lib/complaints';
import {
  createComplaint,
  isComplaintsStorageConfigured,
} from '@/lib/complaints.server';
import { sendComplaintReceipt } from '@/lib/complaints-email.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';

/**
 * POST /api/complaints — Libro de Reclamaciones virtual (público).
 *
 * Seguridad:
 *   · validación server-side; el HTML no decide nada;
 *   · honeypot `company` con respuesta neutra;
 *   · rate limit por IP (5 / 10 min) y tope de cuerpo (32 KB);
 *   · CSRF por Origin en `proxy.ts` (mutaciones de /api);
 *   · la respuesta NO incluye DNI, teléfono ni correo;
 *   · el código de seguimiento es aleatorio, nunca el correlativo.
 *
 * Estados:
 *   201 registrado (aunque el correo no esté configurado)
 *   400 invalid_complaint { errors }
 *   413 payload_too_large
 *   429 rate_limited
 *   503 complaints_unavailable (sin base: no se puede garantizar constancia)
 *   500 complaint_error
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const limited = await rateLimitGate(request, 'complaints', {
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (limited) return limited;

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > COMPLAINT_LIMITS.bodyMaxBytes) {
    return NextResponse.json(
      { ok: false, code: 'payload_too_large', error: 'El formulario es demasiado largo.' },
      { status: 413, headers: NO_STORE },
    );
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > COMPLAINT_LIMITS.bodyMaxBytes) {
      return NextResponse.json(
        { ok: false, code: 'payload_too_large', error: 'El formulario es demasiado largo.' },
        { status: 413, headers: NO_STORE },
      );
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'No pudimos leer el formulario.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const validation = validateComplaintPayload(raw);
  if (!validation.ok) {
    // Honeypot: no se le dice al bot qué campo lo delató.
    if (validation.spam) {
      return NextResponse.json({ ok: true, ignored: true }, { status: 200, headers: NO_STORE });
    }
    return NextResponse.json(
      { ok: false, code: 'invalid_complaint', errors: validation.errors },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!isComplaintsStorageConfigured()) {
    console.error('[reclamaciones] base de datos no configurada');
    return NextResponse.json(
      {
        ok: false,
        code: 'complaints_unavailable',
        error: 'El Libro de Reclamaciones no está disponible en este momento. Intenta más tarde.',
      },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const created = await createComplaint(validation.value);

    // El reclamo ya está guardado. Un fallo de correo NO revierte el registro.
    const emailStatus = await sendComplaintReceipt({
      complaintNumber: created.complaintNumber,
      publicCode: created.publicCode,
      dueAt: created.dueAt,
      kind: validation.value.kind,
      consumerEmail: validation.value.consumerEmail,
      consumerName: validation.value.consumerName,
    });

    return NextResponse.json(
      {
        ok: true,
        complaintNumber: created.complaintNumber,
        publicCode: created.publicCode,
        submittedAt: created.submittedAt,
        dueAt: created.dueAt,
        emailStatus,
        trackingPath: `/libro-de-reclamaciones/seguimiento/${created.publicCode}`,
      },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    console.error('[reclamaciones] no se pudo registrar', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      {
        ok: false,
        code: 'complaint_error',
        error: 'No pudimos registrar tu reclamo. Reintenta en un momento.',
      },
      { status: 500, headers: NO_STORE },
    );
  }
}
