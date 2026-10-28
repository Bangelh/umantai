/**
 * /api/auth/* — Better Auth (email/contraseña y, a futuro, OAuth).
 *
 * El handler se construye por petición para no instanciar el pool durante el
 * build. Better Auth emite la cookie de sesión HttpOnly en la respuesta.
 */

import { getAuthServer } from '@/lib/auth.server';
import { isE2ERequest } from '@/lib/e2e-access.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { logSecurityEvent, requestIdFrom, withRequestLogging } from '@/lib/observability.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Freno de fuerza bruta en credenciales. En memoria por instancia (deuda
 * conocida); suficiente para staging y para cortar ráfagas de un mismo cliente.
 *
 * Un solo gate por petición: antes había una segunda barrera síncrona que
 * contaba el mismo intento dos veces, así que el cupo real era la mitad del
 * anunciado.
 *
 * El cupo alto es SOLO para la corrida E2E, identificada por el header
 * `x-e2e-token` (ver `lib/e2e-access.server.ts`). Un visitante humano de
 * `umantai.com` nunca lo envía, así que conserva los límites normales: el modo
 * test ya no relaja la aplicación entera.
 */
function limits(request: Request) {
  // Se evalúa por request: el flag y el secreto pueden cambiar en runtime.
  const e2e = isE2ERequest(request);
  return {
    credentials: e2e ? 120 : 15,
    recovery: e2e ? 30 : 5,
    general: 90,
  };
}

async function handleGet(request: Request) {
  return getAuthServer().handler(request);
}

function scopeForPath(path: string, request: Request): { scope: string; limit: number } {
  const caps = limits(request);
  if (path.includes('/sign-in/') || path.includes('/sign-up/')) {
    return { scope: 'auth-credentials', limit: caps.credentials };
  }
  if (path.includes('/request-password-reset') || path.includes('/reset-password')) {
    return { scope: 'auth-recovery', limit: caps.recovery };
  }
  return { scope: 'auth', limit: caps.general };
}

async function handlePost(request: Request) {
  const path = new URL(request.url).pathname;
  const { scope, limit } = scopeForPath(path, request);
  const gate = await rateLimitGate(request, scope, { limit, windowMs: 60_000 });
  if (gate) return gate;

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
