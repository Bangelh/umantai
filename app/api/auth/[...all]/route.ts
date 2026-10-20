/**
 * /api/auth/* — Better Auth (email/contraseña y, a futuro, OAuth).
 *
 * El handler se construye por petición para no instanciar el pool durante el
 * build. Better Auth emite la cookie de sesión HttpOnly en la respuesta.
 */

import { getAuthServer } from '@/lib/auth.server';
import { isAuthTestMode } from '@/lib/email.server';
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
 * En `AUTH_TEST_MODE` (nunca Producción) el cupo sube para que la suite E2E
 * pueda crear y entrar a varias cuentas en el mismo minuto. El modo test ya
 * escribe tokens en `email_outbox`, así que no amplía nada que no estuviera
 * habilitado explícitamente.
 */
function limits() {
  // Se evalúa por request: en un build de staging el modo test puede estar
  // apagado y encenderse solo en runtime.
  const testMode = isAuthTestMode();
  return {
    credentials: testMode ? 120 : 15,
    recovery: testMode ? 30 : 5,
    general: 90,
  };
}

async function handleGet(request: Request) {
  return getAuthServer().handler(request);
}

function scopeForPath(path: string): { scope: string; limit: number } {
  const caps = limits();
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
  const { scope, limit } = scopeForPath(path);
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
