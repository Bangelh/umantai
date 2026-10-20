/**
 * /api/auth/* — Better Auth (email/contraseña y, a futuro, OAuth).
 *
 * El handler se construye por petición para no instanciar el pool durante el
 * build. Better Auth emite la cookie de sesión HttpOnly en la respuesta.
 */

import { NextResponse } from 'next/server';
import { getAuthServer } from '@/lib/auth.server';
import { consumeRateLimit, rateLimitKeyFor } from '@/lib/rate-limit.server';
import { logSecurityEvent, requestIdFrom } from '@/lib/observability.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Freno de fuerza bruta en credenciales. En memoria por instancia (deuda
 * conocida); suficiente para staging y para cortar ráfagas de un mismo cliente.
 */
function rateLimited(request: Request): NextResponse | null {
  const path = new URL(request.url).pathname;
  const credentials = path.includes('/sign-in/') || path.includes('/sign-up/');
  const limit = consumeRateLimit(
    rateLimitKeyFor(request, credentials ? 'auth-credentials' : 'auth'),
    credentials ? 15 : 90,
    60_000,
  );
  if (limit.allowed) return null;
  logSecurityEvent('auth_rate_limited', {
    path,
    requestId: requestIdFrom(request),
  });
  return NextResponse.json(
    {
      code: 'rate_limited',
      message: 'Demasiados intentos. Espera un minuto y vuelve a intentar.',
    },
    {
      status: 429,
      headers: { 'Retry-After': String(limit.retryAfterSeconds), 'cache-control': 'no-store' },
    },
  );
}

export async function GET(request: Request) {
  return getAuthServer().handler(request);
}

export async function POST(request: Request) {
  const limited = rateLimited(request);
  if (limited) return limited;

  const response = await getAuthServer().handler(request);
  if (response.status >= 400) {
    logSecurityEvent('auth_request_failed', {
      path: new URL(request.url).pathname,
      status: response.status,
      requestId: requestIdFrom(request),
    });
  }
  return response;
}
