import { NextResponse } from 'next/server';
import { requireAdminToken } from './admin.server';
import { isCommerceDbConfigured } from './commerce.server';
import { enforceRateLimit, rateLimitKeyFor } from './rate-limit.server';

export type AdminMutationGuard = { ok: true } | { ok: false; response: NextResponse };

/**
 * Portero común de las mutaciones de inventario: auth → base configurada → rate
 * limit. Devuelve una respuesta lista para retornar, o `ok` para seguir.
 *
 * Es async porque el rate limit usa un backend sustituible (memory hoy, Redis/KV
 * mañana) sin que las rutas cambien.
 */
export async function guardAdminMutation(
  request: Request,
  scope: string,
): Promise<AdminMutationGuard> {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, code: access.code, error: access.message },
        { status: access.status },
      ),
    };
  }

  if (!isCommerceDbConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
        { status: 503 },
      ),
    };
  }

  // 30 mutaciones por minuto por IP y ruta. Suficiente para operación manual.
  const limit = await enforceRateLimit(request, scope, { limit: 30, windowMs: 60_000 });
  if (!limit.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          code: 'rate_limited',
          error: 'Demasiadas escrituras seguidas. Espera unos segundos y reintenta.',
        },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
      ),
    };
  }

  return { ok: true };
}

/** Clave usada por el guard histórico (export para tests/diagnóstico). */
export function adminMutationKey(request: Request, scope: string): string {
  return rateLimitKeyFor(request, scope);
}
