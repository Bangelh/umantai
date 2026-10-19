/**
 * GET /api/health — healthcheck portable (Railway, Vercel, contenedores).
 *
 * Devuelve sólo estado operativo: ok, versión, commit, entorno, si la base
 * responde, tipo de driver y timestamp. Nunca URLs, usuarios ni secretos.
 *
 * 200 → base alcanzable · 503 → base caída o no configurada.
 */

import { checkDatabaseReachable, healthResponse } from '@/lib/health.server';

// El estado debe medirse en cada petición, nunca servirse desde caché.
export const dynamic = 'force-dynamic';

export async function GET() {
  return healthResponse({ checkDatabase: checkDatabaseReachable });
}
