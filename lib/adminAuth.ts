/**
 * lib/adminAuth.ts — token de administración en el navegador (cliente).
 *
 * HISTORIA: antes la UI pedía `ADMIN_API_SECRET` y lo guardaba en localStorage.
 * Eso ya NO es el camino humano: los paneles usan la sesión de Platform Admin
 * (cookie firmada, HttpOnly). Este archivo queda para dos cosas puntuales:
 *
 *   1. `withAdminAuth()` sin token: deja que la cookie viaje sola (`same-origin`).
 *   2. Automatización/CI: pasar un token explícito manda `x-admin-token`. El
 *      token NUNCA se pide en pantalla ni se persiste por defecto.
 *
 * La validación REAL ocurre en el servidor (`lib/admin.server.ts`).
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
export function withAdminAuth(init: RequestInit = {}, token = ''): RequestInit {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  // Solo automatización explícita manda el header. Sin token, la cookie de
  // Platform Admin (`HttpOnly`) es la que autentica.
  if (token) headers[ADMIN_TOKEN_HEADER] = token;
  return { ...init, headers, credentials: init.credentials ?? 'same-origin' };
}
