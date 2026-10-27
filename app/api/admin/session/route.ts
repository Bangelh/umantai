import { NextResponse } from 'next/server';

import { getSessionUser } from '@/lib/auth.server';
import { requireAdminAccess, verifyAdminToken } from '@/lib/admin.server';
import { getPlatformSql } from '@/lib/platform-db.server';
import {
  createPlatformAdminToken,
  getPlatformAdminGrantState,
  getPlatformAdminSession,
  isPlatformAdminSessionConfigured,
  isPlatformAdminUser,
  PLATFORM_ADMIN_COOKIE,
  PLATFORM_ADMIN_TTL_SECONDS,
} from '@/lib/platform-admin.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * GET  — estado de la sesión de plataforma.
 * POST — cambia la sesión de Better Auth por la cookie firmada de admin.
 * DELETE — revoca la cookie de admin.
 */

export async function GET(request: Request) {
  const session = getPlatformAdminSession(request);
  if (session) {
    // La cookie solo prueba identidad: el rol se revalida en cada consulta, así
    // que el panel deja de mostrarse autenticado apenas se revoca el grant.
    const state = await getPlatformAdminGrantState(session.userId);
    if (state === 'active') {
      let email: string | null = null;
      let name: string | null = null;
      const sql = getPlatformSql();
      if (sql) {
        try {
          const rows = await sql`
            SELECT email, name FROM users WHERE id = ${session.userId} LIMIT 1
          `;
          email = rows[0]?.email ? String(rows[0].email) : null;
          name = rows[0]?.name ? String(rows[0].name) : null;
        } catch {
          // La cookie y el rol ya están verificados; el detalle es cosmético.
        }
      }
      return NextResponse.json(
        { ok: true, authenticated: true, via: 'session', user: { id: session.userId, email, name } },
        { headers: NO_STORE },
      );
    }

    const response = NextResponse.json(
      { ok: true, authenticated: false, via: 'session', revoked: state === 'revoked' },
      { headers: NO_STORE },
    );
    if (state === 'revoked') {
      // Se descarta la cookie inservible para que el siguiente intento sea limpio.
      response.cookies.set({
        name: PLATFORM_ADMIN_COOKIE,
        value: '',
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 0,
      });
    }
    return response;
  }

  const viaToken = verifyAdminToken(request.headers.get('x-admin-token'));
  return NextResponse.json(
    {
      ok: true,
      authenticated: viaToken,
      via: viaToken ? 'token' : null,
      configured: isPlatformAdminSessionConfigured(),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!isPlatformAdminSessionConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: 'admin_session_not_configured',
        error: 'Falta PLATFORM_ADMIN_SECRET (o BETTER_AUTH_SECRET) de al menos 32 caracteres.',
      },
      { status: 503, headers: NO_STORE },
    );
  }

  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { ok: false, code: 'not_authenticated', error: 'Inicia sesión con tu cuenta.' },
      { status: 401, headers: NO_STORE },
    );
  }

  if (!(await isPlatformAdminUser(user))) {
    return NextResponse.json(
      { ok: false, code: 'admin_forbidden', error: 'Esta cuenta no es Platform Admin.' },
      { status: 403, headers: NO_STORE },
    );
  }

  const token = createPlatformAdminToken(user.id);
  if (!token) {
    return NextResponse.json(
      { ok: false, code: 'admin_session_not_configured', error: 'Sesión de admin no configurada.' },
      { status: 503, headers: NO_STORE },
    );
  }

  const response = NextResponse.json(
    {
      ok: true,
      authenticated: true,
      via: 'session',
      user: { id: user.id, email: user.email, name: user.name },
    },
    { headers: NO_STORE },
  );
  response.cookies.set({
    name: PLATFORM_ADMIN_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: PLATFORM_ADMIN_TTL_SECONDS,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set({
    name: PLATFORM_ADMIN_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return response;
}

/** Compatibilidad: algún cliente antiguo podría pedir el estado con token. */
export async function HEAD(request: Request) {
  const access = await requireAdminAccess(request);
  return new NextResponse(null, { status: access.ok ? 204 : access.status, headers: NO_STORE });
}
