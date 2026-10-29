/**
 * POST /api/account/verification/resend — reenvía el correo de verificación de
 * la cuenta que tiene la sesión.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  Better Auth solo envía la verificación al registrarse (`sendOnSignUp: true`).
 *  Una cuenta no verificada no tenía ninguna forma de pedir otro enlace: si el
 *  correo no llegó (rebotó, quedó en spam, o la cuenta es anterior al envío), la
 *  única salida era crear otra cuenta. La UI ya decía "Correo sin verificar"
 *  pero no ofrecía la acción.
 *
 *  DECISIONES
 *   · El correo NO viene del cliente: se usa el de la sesión. Así no hay forma
 *     de sondear si una dirección ajena existe (anti-enumeración), y Better Auth
 *     revalida que coincida con la sesión antes de firmar el token.
 *   · Un solo envío por minuto y por usuario (no por IP): el clic repetido no
 *     genera correos en cadena y un NAT compartido no bloquea a terceros.
 *   · Si la cuenta ya está verificada no se envía nada: respuesta idempotente.
 *   · El token de verificación es un JWT firmado por Better Auth con caducidad
 *     de 24 h (`emailVerification.expiresIn`); pedir uno nuevo no invalida el
 *     anterior, pero el enlace vence solo y verificar dos veces es inocuo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextResponse } from 'next/server';

import { getAuthServer, getSessionUser } from '@/lib/auth.server';
import { resolveEmailProviderName } from '@/lib/email.server';
import { logEvent, logSecurityEvent } from '@/lib/observability.server';
import { enforceRateLimit } from '@/lib/rate-limit.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ventana del cooldown: un correo por minuto y cuenta. */
const COOLDOWN_MS = 60_000;

/** A dónde vuelve el enlace del correo después de verificar. */
const CALLBACK_PATH = '/cuenta/verificado';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { ok: false, code: 'not_authenticated', error: 'Necesitas iniciar sesión.' },
      { status: 401, headers: NO_STORE },
    );
  }

  // Ya verificado: no se envía nada ni se consume el cupo.
  if (user.emailVerified) {
    return NextResponse.json({ ok: true, status: 'already_verified' }, { headers: NO_STORE });
  }

  // Sin proveedor no hay nada que enviar: se falla cerrado ANTES de gastar el
  // cooldown, para que el usuario pueda reintentar cuando el correo vuelva.
  if (resolveEmailProviderName(user.email) === 'disabled') {
    logSecurityEvent('verification_resend_unavailable', { userId: user.id });
    return NextResponse.json(
      {
        ok: false,
        code: 'email_unavailable',
        error: 'El envío de correo no está disponible ahora mismo.',
      },
      { status: 503, headers: NO_STORE },
    );
  }

  const limit = await enforceRateLimit(request, 'verify-email-resend', {
    limit: 1,
    windowMs: COOLDOWN_MS,
    key: `verify-email-resend:${user.id}`,
  });
  if (!limit.allowed) {
    logSecurityEvent('verification_resend_cooldown', { userId: user.id });
    return NextResponse.json(
      {
        ok: false,
        code: 'cooldown',
        retryAfterSeconds: limit.retryAfterSeconds,
        error: 'Espera un momento antes de pedir otro correo.',
      },
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(limit.retryAfterSeconds) },
      },
    );
  }

  try {
    await getAuthServer().api.sendVerificationEmail({
      body: { email: user.email, callbackURL: CALLBACK_PATH },
      headers: request.headers,
    });
  } catch (error) {
    logSecurityEvent('verification_resend_failed', {
      userId: user.id,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      { ok: false, code: 'send_failed', error: 'No pudimos enviar el correo.' },
      { status: 502, headers: NO_STORE },
    );
  }

  logEvent('verification_resent', {
    userId: user.id,
    provider: resolveEmailProviderName(user.email),
  });

  return NextResponse.json({ ok: true, status: 'sent' }, { headers: NO_STORE });
}
