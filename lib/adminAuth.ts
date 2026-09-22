/**
 * lib/adminAuth.ts — token de administración en el navegador (cliente).
 *
 * El panel `/admin` ya no lleva una contraseña hardcodeada: eso era security
 * theater, porque viajaba en el bundle que descarga cualquier visitante. Ahora la
 * UI pide el `ADMIN_API_SECRET` del servidor como "token de administración", lo
 * guarda en `localStorage` y lo manda en el header `x-admin-token` en cada llamada
 * a una API de administración.
 *
 * La validación REAL ocurre en el servidor (`lib/admin.server.ts`, comparación en
 * tiempo constante). Este archivo solo transporta el token.
 *
 * Nota: si `localStorage` no está disponible (modo privado), el token se conserva
 * en memoria durante la sesión en vez de perderse.
 */

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

const STORAGE_KEY = 'umantai-admin-token';

/** Respaldo en memoria cuando `localStorage` falla o no existe (SSR). */
let inMemoryToken = '';

export function getAdminToken(): string {
  if (typeof window === 'undefined') return inMemoryToken;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? inMemoryToken;
  } catch {
    return inMemoryToken;
  }
}

export function setAdminToken(token: string): void {
  const value = token.trim();
  inMemoryToken = value;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* almacenamiento no disponible: queda en memoria por esta sesión */
  }
}

export function clearAdminToken(): void {
  inMemoryToken = '';
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada que limpiar */
  }
}

/**
 * Añade el header de administración a un `fetch`.
 *
 *   fetch('/api/admin/overrides', withAdminAuth({ method: 'POST', body }))
 *
 * El segundo parámetro permite verificar un token candidato antes de guardarlo
 * (p. ej. en el login), sin escribirlo aún en el almacenamiento.
 */
export function withAdminAuth(init: RequestInit = {}, token: string = getAdminToken()): RequestInit {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (token) headers[ADMIN_TOKEN_HEADER] = token;
  return { ...init, headers };
}
