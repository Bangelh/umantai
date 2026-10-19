/**
 * /api/auth/* — Better Auth (email/contraseña y, a futuro, OAuth).
 *
 * El handler se construye por petición para no instanciar el pool durante el
 * build. Better Auth emite la cookie de sesión HttpOnly en la respuesta.
 */

import { getAuthServer } from '@/lib/auth.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return getAuthServer().handler(request);
}

export async function POST(request: Request) {
  return getAuthServer().handler(request);
}
