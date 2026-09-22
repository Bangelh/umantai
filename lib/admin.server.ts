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
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

/**
 * Portero único de las rutas de administración.
 *
 * Devuelve datos, no una `NextResponse`, para no acoplar la librería a Next:
 * cada ruta traduce `ok: false` a su respuesta HTTP en dos líneas y con el
 * formato de error que ya usa esa ruta.
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
    return {
      ok: false,
      status: 401,
      code: 'admin_unauthorized',
      message: 'Token de administración inválido o ausente.',
    };
  }

  return { ok: true };
}
