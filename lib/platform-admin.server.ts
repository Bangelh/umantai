/**
 * lib/platform-admin.server.ts — sesión firmada de Platform Admin.
 *
 * Flujo:
 *   1. El usuario inicia sesión con Better Auth (cookie HttpOnly de sesión).
 *   2. `/api/admin/session` comprueba que su usuario esté en `platform_admins`
 *      (o en `PLATFORM_ADMIN_EMAILS` para el bootstrap).
 *   3. Emite `umantai_platform_admin`: HMAC-SHA256, HttpOnly, SameSite=Strict,
 *      Secure en producción, 8 horas.
 *
 * `requireAdminToken` valida la firma de forma síncrona (sin DB), así las rutas
 * existentes no cambian. El token compartido queda como respaldo de desarrollo.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { getPrefixedEnv } from './env';
import { getPlatformSql } from './platform-db.server';

export const PLATFORM_ADMIN_COOKIE = 'umantai_platform_admin';
export const PLATFORM_ADMIN_TTL_SECONDS = 8 * 60 * 60;

function cookieSecret(): string {
  return (
    getPrefixedEnv('PLATFORM_ADMIN_SECRET') ??
    getPrefixedEnv('BETTER_AUTH_SECRET') ??
    getPrefixedEnv('AUTH_SECRET') ??
    ''
  ).trim();
}

export function isPlatformAdminSessionConfigured(): boolean {
  return cookieSecret().length >= 32;
}

function sign(payload: string): string {
  return createHmac('sha256', cookieSecret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createPlatformAdminToken(
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (!isPlatformAdminSessionConfigured()) return null;
  if (!userId.trim()) return null;
  const expires = nowSeconds + PLATFORM_ADMIN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ v: 1, u: userId, e: expires })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyPlatformAdminToken(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): { userId: string } | null {
  if (!token || !isPlatformAdminSessionConfigured()) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  if (!safeEqual(signature, sign(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: number;
      u?: string;
      e?: number;
    };
    if (parsed.v !== 1 || typeof parsed.u !== 'string' || typeof parsed.e !== 'number') {
      return null;
    }
    if (parsed.e <= nowSeconds) return null;
    return { userId: parsed.u };
  } catch {
    return null;
  }
}

/** Lee la cookie sin depender de `NextRequest`. */
export function readPlatformAdminCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PLATFORM_ADMIN_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function getPlatformAdminSession(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1000),
): { userId: string } | null {
  return verifyPlatformAdminToken(readPlatformAdminCookie(request), nowSeconds);
}

export type PlatformAdminAccess =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 503; code: string; message: string };

/**
 * Puerta ESTRICTA para datos sensibles (p. ej. Libro de Reclamaciones).
 *
 * A diferencia de `requireAdminToken`, NO acepta el token compartido: exige la
 * cookie firmada emitida tras validar la cuenta en `platform_admins`. Un token
 * de automatización no debe poder leer DNI, teléfonos ni correos.
 */
export function requirePlatformAdminSession(request: Request): PlatformAdminAccess {
  if (!isPlatformAdminSessionConfigured()) {
    return {
      ok: false,
      status: 503,
      code: 'admin_session_not_configured',
      message: 'Falta PLATFORM_ADMIN_SECRET (o BETTER_AUTH_SECRET) de al menos 32 caracteres.',
    };
  }

  const session = getPlatformAdminSession(request);
  if (!session) {
    return {
      ok: false,
      status: 401,
      code: 'admin_session_required',
      message: 'Inicia sesión como Platform Admin para ver esta información.',
    };
  }

  return { ok: true, userId: session.userId };
}

function bootstrapEmails(): string[] {
  return (getPrefixedEnv('PLATFORM_ADMIN_EMAILS') ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Autorización real: tabla `platform_admins` o allowlist de bootstrap.
 * Falla cerrado si no hay DB y el correo no está en la allowlist.
 */
export async function isPlatformAdminUser(user: {
  id: string;
  email: string;
}): Promise<boolean> {
  const email = user.email.trim().toLowerCase();
  if (email && bootstrapEmails().includes(email)) return true;

  const sql = getPlatformSql();
  if (!sql) return false;
  try {
    const rows = await sql`
      SELECT 1 FROM platform_admins WHERE user_id = ${user.id} LIMIT 1
    `;
    return rows.length > 0;
  } catch (error) {
    // Tabla ausente o DB caída: no se concede acceso.
    console.error('[platform-admin] no se pudo verificar el rol', error);
    return false;
  }
}
