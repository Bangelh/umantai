/**
 * /api/account/sessions — sesiones activas del usuario de la cookie.
 *
 *   GET  → lista las sesiones vigentes (sin token: nunca se expone al cliente).
 *   POST → cierra todas las demás sesiones del usuario.
 *
 * Se lee la tabla `sessions` de Better Auth con el `userId` resuelto en el
 * servidor: el cliente no puede pedir las sesiones de otra cuenta.
 */

import { NextResponse } from 'next/server';
import { getAuthServer, getSessionUser } from '@/lib/auth.server';
import { requirePlatformSql } from '@/lib/platform-db.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json(
    { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
    { status: 401 },
  );
}

export async function GET(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) return unauthorized();

  try {
    const sql = requirePlatformSql();
    const rows = await sql`
      SELECT id, "expiresAt", "createdAt", "userAgent"
        FROM sessions
       WHERE "userId" = ${user.id}
         AND "expiresAt" > NOW()
       ORDER BY "createdAt" DESC
       LIMIT 20
    `;
    return NextResponse.json({ sessions: rows });
  } catch {
    return NextResponse.json(
      { error: 'No se pudieron leer las sesiones.', code: 'sessions_unavailable' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) return unauthorized();

  try {
    // La sesión actual se conserva; el resto se revoca en la misma tabla que
    // usa Better Auth.
    const current = await getAuthServer().api.getSession({ headers: request.headers });
    const currentId = current?.session?.id ?? null;

    const sql = requirePlatformSql();
    const rows = currentId
      ? await sql`
          DELETE FROM sessions
           WHERE "userId" = ${user.id}
             AND id <> ${currentId}
          RETURNING id
        `
      : await sql`
          DELETE FROM sessions
           WHERE "userId" = ${user.id}
          RETURNING id
        `;
    return NextResponse.json({ revoked: rows.length });
  } catch {
    return NextResponse.json(
      { error: 'No se pudieron cerrar las sesiones.', code: 'sessions_revoke_failed' },
      { status: 503 },
    );
  }
}
