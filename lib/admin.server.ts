/**
 * lib/admin.server.ts — portero de las rutas de administración.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE ESTE ARCHIVO
 *
 *  El panel `/admin` se "protegía" con una contraseña escrita en el bundle del
 *  cliente (`"umantai"`, incluso impresa en pantalla) y sus rutas `/api/admin/*`,
 *  las de catálogo (`/api/products`, `/api/categories`, `/api/brands`) y las de
 *  notas estaban ABIERTAS: cualquiera podía cambiar precios, vaciar stock, crear
 *  tablas o leer datos de todos los usuarios.
 *
 *  Este es el mismo patrón pragmático que ya usa el kiosco (`lib/kiosk.server.ts`)
 *  mientras llega la V2 con Supabase Auth + roles: una clave compartida
 *  (`ADMIN_API_SECRET`) verificada en el SERVIDOR, que el navegador manda por el
 *  header `x-admin-token`. No está en el bundle porque el token lo teclea el
 *  administrador y se guarda en su navegador, no en el código.
 *
 *  LO QUE NO RESUELVE: es una clave compartida, así que no identifica a la
 *  persona ni permite auditoría por usuario. Para eso hace falta autenticación
 *  real (trabajo de la V2).
 *
 *  SI FALTA LA VARIABLE, LA API QUEDA CERRADA, NO ABIERTA: falla cerrado (503),
 *  igual que el kiosco. Nunca "si no hay clave, dejo pasar".
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getPrefixedEnv } from './env';
import { getPlatformAdminGrantState, getPlatformAdminSession } from './platform-admin.server';
import { logSecurityEvent } from './observability.server';

/** Header donde viaja el token de administración. */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/** Mínimo exigido al secreto: menos que esto se rompe por fuerza bruta. */
const MIN_ADMIN_SECRET_LENGTH = 16;

export function getAdminApiSecret(): string {
  // getPrefixedEnv soporta los prefijos de Vercel (BANGELH_ / UMANTAI_URL_ / UMANTAI_).
  return (getPrefixedEnv('ADMIN_API_SECRET') ?? '').trim();
}

/** ¿Está configurada la API de administración? Si no, las rutas responden 503. */
export function isAdminApiConfigured(): boolean {
  return getAdminApiSecret().length > 0;
}

/** Se avisa en logs (una sola vez por proceso) si el secreto es demasiado corto. */
let warnedAboutShortSecret = false;

function warnIfWeakSecret(secret: string): void {
  if (warnedAboutShortSecret) return;
  if (secret.length >= MIN_ADMIN_SECRET_LENGTH) return;
  warnedAboutShortSecret = true;
  console.warn(
    `⚠️  ADMIN_API_SECRET tiene ${secret.length} caracteres. Usa al menos ${MIN_ADMIN_SECRET_LENGTH} ` +
      '(protege precios, stock y datos de clientes).',
  );
}

/**
 * Comparación de longitud constante.
 *
 * La longitud sí se filtra (corta en el primer `if`); lo que no se filtra es el
 * contenido, que es lo que permitiría reconstruir el secreto byte a byte midiendo
 * tiempos de respuesta.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyAdminToken(provided: string | null | undefined): boolean {
  const expected = getAdminApiSecret();
  // Sin secreto configurado, NADA pasa.
  if (!expected) return false;
  if (typeof provided !== 'string') return false;
  const candidate = provided.trim();
  if (!candidate) return false;
  warnIfWeakSecret(expected);
  return constantTimeEquals(candidate, expected);
}

export type AdminAccessCheck =
  | { ok: true; via?: 'session' | 'token'; userId?: string }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

/**
 * Portero único de las rutas de administración: sesión o token. SIEMPRE async.
 *
 * Devuelve datos, no una `NextResponse`, para no acoplar la librería a Next:
 * cada ruta traduce `ok: false` a su respuesta HTTP en dos líneas y con el
 * formato de error que ya usa esa ruta.
 *
 * La cookie de Platform Admin se revalida contra `platform_admins` en cada
 * petición (`getPlatformAdminGrantState`): retirar el rol corta el acceso en el
 * acto, aunque la cookie siga firmada y vigente. Es async justo por eso.
 */
export async function requireAdminAccess(request: Request): Promise<AdminAccessCheck> {
  // 1. Sesión real de Platform Admin (cookie firmada emitida tras login).
  const session = getPlatformAdminSession(request);
  if (session) {
    const state = await getPlatformAdminGrantState(session.userId);
    if (state === 'active') {
      return { ok: true, via: 'session', userId: session.userId };
    }

    const requestId = request.headers.get('x-request-id');
    if (state === 'unavailable') {
      logSecurityEvent('admin_grant_check_failed', { requestId });
      return {
        ok: false,
        status: 503,
        code: 'admin_check_unavailable',
        message: 'No pudimos verificar tu acceso de Platform Admin. Reintenta en unos segundos.',
      };
    }

    // Rol revocado (o cuenta borrada): la cookie NO alcanza para operar.
    logSecurityEvent('admin_grant_inactive', { userId: session.userId, requestId });
    return {
      ok: false,
      status: 403,
      code: 'admin_grant_inactive',
      message: 'Tu acceso de Platform Admin ya no está activo.',
    };
  }

  // 2. Sin cookie de sesión: solo el token compartido (automatización).
  return requireAdminToken(request);
}

/**
 * Puerta del token compartido (`x-admin-token`).
 *
 * NO acepta la cookie de Platform Admin: esa pasa por `requireAdminAccess`, que
 * sí revalida el rol contra la base. Así no existe un camino de autorización
 * que se salte la revocación.
 */
export function requireAdminToken(request: Request): AdminAccessCheck {
  if (!isAdminApiConfigured()) {
    return {
      ok: false,
      status: 503,
      code: 'admin_not_configured',
      message:
        'La API de administración no está configurada: falta ADMIN_API_SECRET en el entorno del servidor.',
    };
  }

  if (!verifyAdminToken(request.headers.get(ADMIN_TOKEN_HEADER))) {
    logSecurityEvent('admin_unauthorized', {
      hasSessionCookie: !!request.headers.get('cookie'),
      hasTokenHeader: !!request.headers.get(ADMIN_TOKEN_HEADER),
      requestId: request.headers.get('x-request-id'),
    });
    return {
      ok: false,
      status: 401,
      code: 'admin_unauthorized',
      message: 'Inicia sesión como Platform Admin o envía un token válido.',
    };
  }

  // En Producción la autenticación real es obligatoria. El token compartido
  // solo se admite como emergencia explícita.
  if (
    process.env.APP_ENV === 'production' &&
    process.env.ALLOW_ADMIN_TOKEN_FALLBACK !== '1'
  ) {
    return {
      ok: false,
      status: 403,
      code: 'admin_session_required',
      message: 'Platform Admin requiere una sesión autenticada.',
    };
  }

  logSecurityEvent('admin_token_fallback_used', {
    requestId: request.headers.get('x-request-id'),
  });
  return { ok: true, via: 'token' };
}
