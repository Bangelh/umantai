/**
 * lib/rate-limit-http.server.ts — puerta de rate limit lista para una ruta.
 *
 * Las rutas hacen:
 *
 *   const limited = await rateLimitGate(request, 'orders', { limit: 10 });
 *   if (limited) return limited;
 *
 * El backend real vive en `lib/rate-limit.server.ts` (memory → distribuido sin
 * tocar las rutas). La respuesta es uniforme y no revela el cupo exacto.
 */

import { NextResponse } from 'next/server';

import { logSecurityEvent } from './observability.server';
import { enforceRateLimit, type RateLimitOptions } from './rate-limit.server';

export async function rateLimitGate(
  request: Request,
  scope: string,
  options: RateLimitOptions = {},
): Promise<NextResponse | null> {
  const result = await enforceRateLimit(request, scope, options);
  if (result.allowed) return null;

  logSecurityEvent('rate_limited', {
    scope,
    requestId: request.headers.get('x-request-id'),
  });

  return NextResponse.json(
    { ok: false, code: 'rate_limited', error: 'Demasiadas solicitudes. Intenta en unos segundos.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSeconds),
        'cache-control': 'no-store',
      },
    },
  );
}
