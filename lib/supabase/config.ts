/**
 * lib/supabase/config.ts — validación mínima de configuración de Supabase.
 *
 * POR QUÉ EXISTE
 *   `createClient()` de `@supabase/supabase-js` lanza en el momento de
 *   construirse si la URL no es un http(s) válido. Varios módulos lo hacían a
 *   nivel de import, así que un placeholder del tipo
 *   `NEXT_PUBLIC_SUPABASE_URL=tu_url_de_supabase` rompía `next build` al
 *   recolectar `/api/notes`, aunque Notes/Shopping List sean opcionales.
 *
 *   Acá la URL se valida ANTES de crear el cliente: si falta o es inválida, el
 *   cliente queda `null` y la ruta responde 503 "no configurado". Nunca se
 *   inventa una URL para que el build pase.
 *
 * Sin dependencias de Node ni de Next: se puede importar desde Edge/middleware.
 */

/** `true` sólo para URLs absolutas http/https realmente parseables. */
export function isValidHttpUrl(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Un cliente Supabase sólo tiene sentido con URL válida y key no vacía. */
export function isSupabaseConfigured(
  url: string | undefined | null,
  key: string | undefined | null,
): boolean {
  return isValidHttpUrl(url) && typeof key === 'string' && key.trim().length > 0;
}
