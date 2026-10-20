/**
 * /api/auth/* — Better Auth (email/contraseña y, a futuro, OAuth).
 *
 * El handler se construye por petición para no instanciar el pool durante el
 * build. Better Auth emite la cookie de sesión HttpOnly en la respuesta.
 */

import { NextResponse } from 'next/server';
import { getAuthServer } from '@/lib/auth.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { consumeRateLimit, rateLimitKeyFor } from '@/lib/rate-limit.server';
import { logSecurityEvent, requestIdFrom, withRequestLogging } from '@/lib/observability.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Freno de fuerza bruta en credenciales. En memoria por instancia (deuda
 * conocida); suficiente para staging y para cortar ráfagas de un mismo cliente.
 */
function rateLimited(request: Request): NextResponse | null {
  const path = new URL(request.url).pathname;
  const credentials = path.includes('/sign-in/') || path.includes('/sign-up/');
  const reset = path.includes('/forget-password') || path.includes('/reset-password');
  const limit = consumeRateLimit(
    rateLimitKeyFor(request, credentials ? 'auth-credentials' : reset ? 'auth-recovery' : 'auth'),
    credentials ? 15 : reset ? 5 : 90,
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

async function handleGet(request: Request) {
  return getAuthServer().handler(request);
}

async function handlePost(request: Request) {
  const path = new URL(request.url).pathname;
  // El gate async es el camino nuevo (provider sustituible). El límite síncrono
  // se conserva como segunda barrera por compatibilidad con la suite histórica.
  const gate = await rateLimitGate(
    request,
    path.includes('/sign-in/') || path.includes('/sign-up/')
      ? 'auth-credentials'
      : path.includes('/forget-password') || path.includes('/reset-password')
        ? 'auth-recovery'
        : 'auth',
    {
      limit:
        path.includes('/sign-in/') || path.includes('/sign-up/')
          ? 15
          : path.includes('/forget-password') || path.includes('/reset-password')
            ? 5
            : 90,
      windowMs: 60_000,
    },
  );
  if (gate) return gate;

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

export const GET = withRequestLogging('/api/auth', handleGet);
export const POST = withRequestLogging('/api/auth', handlePost);
