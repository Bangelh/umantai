/**
 * GET /api/auth/test/outbox?email=...&purpose=verify_email|reset_password|store_created
 *
 * Solo para corridas E2E. Exige TRES condiciones:
 *
 *   1. `AUTH_TEST_MODE=1` y entorno distinto de Producción.
 *   2. `E2E_TEST_TOKEN` configurado y header `x-e2e-token` correcto
 *      (comparación en tiempo constante).
 *   3. El correo consultado debe ser del dominio reservado `umantai.test`.
 *
 * Si falta cualquiera, responde 404: no revela que el endpoint existe ni
 * distingue "deshabilitado" de "token incorrecto". El correo de una persona
 * real nunca pasa por acá, así que sus enlaces no son legibles desde afuera.
 */

import { NextResponse } from 'next/server';

import { isE2ERequest, isE2EConfigured } from '@/lib/e2e-access.server';
import {
  isAuthTestMode,
  isTestRecipient,
  readLatestOutboxMessage,
  type EmailPurpose,
} from '@/lib/email.server';
import { enforceRateLimit } from '@/lib/rate-limit.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };
const PURPOSES = new Set<EmailPurpose>(['verify_email', 'reset_password', 'store_created']);

function notFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE });
}

export async function GET(request: Request) {
  if (!isAuthTestMode() || !isE2EConfigured() || !isE2ERequest(request)) {
    return notFound();
  }

  const limit = await enforceRateLimit(request, 'auth-test-outbox', {
    limit: 30,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, code: 'rate_limited' },
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(limit.retryAfterSeconds) },
      },
    );
  }

  const url = new URL(request.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const rawPurpose = url.searchParams.get('purpose') ?? '';
  const purpose = PURPOSES.has(rawPurpose as EmailPurpose)
    ? (rawPurpose as EmailPurpose)
    : undefined;

  if (!email || !email.includes('@')) {
    return NextResponse.json(
      { ok: false, error: 'email requerido' },
      { status: 400, headers: NO_STORE },
    );
  }

  // Aunque el token sea válido, solo se leen buzones de prueba. Protege contra
  // un token filtrado usado para cosechar enlaces de cuentas reales.
  if (!isTestRecipient(email)) {
    return notFound();
  }

  try {
    const message = await readLatestOutboxMessage(email, purpose);
    if (!message) {
      return NextResponse.json({ ok: true, message: null }, { headers: NO_STORE });
    }
    return NextResponse.json(
      {
        ok: true,
        message: {
          purpose: message.purpose,
          recipient: message.recipient,
          subject: message.subject,
          actionUrl: message.actionUrl,
          createdAt: message.createdAt,
        },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[auth] no se pudo leer el outbox de test', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json(
      { ok: false, error: 'outbox_unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }
}
