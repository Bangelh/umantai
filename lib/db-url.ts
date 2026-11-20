/**
 * lib/db-url.ts — URL de base de datos para RUNTIME (sin dependencias).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  Supabase ofrece tres cadenas distintas y no son intercambiables:
 *
 *    · Directa        db.<ref>.supabase.co:5432        migraciones, seeds, dumps
 *    · Pooler sesión  ...pooler.supabase.com:5432      máx. pool_size (15) clientes
 *    · Pooler trans.  ...pooler.supabase.com:6543      multiplexa por transacción
 *
 *  La app corría contra el pooler en modo SESIÓN y cada instancia de función
 *  abría su propio pool: al llegar a 15 clientes, Postgres respondía
 *  `EMAXCONNSESSION` y la página devolvía 500. En runtime la cadena correcta es
 *  la de modo TRANSACCIÓN (puerto 6543): el pooler reasigna la conexión en cada
 *  transacción y no hace falta una por instancia.
 *
 *  Este módulo NO conecta: solo decide la URL. Es puro para poder testearlo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Puerto del pooler de Supabase en modo transacción. */
export const SUPABASE_TRANSACTION_PORT = '6543';

function isSupabasePoolerHost(hostname: string): boolean {
  return /(^|\.)pooler\.supabase\.com$/i.test(hostname);
}

/**
 * Devuelve la URL de runtime: si apunta al pooler de Supabase en el puerto de
 * sesión (5432), la mueve al de transacción (6543).
 *
 * Se reemplaza solo el `host:puerto`, sin reconstruir la URL: así la contraseña
 * y los parámetros (`?pgbouncer=true&sslmode=require`) quedan intactos aunque
 * tengan caracteres codificados. Una cadena directa (`db.<ref>.supabase.co`) o
 * un Postgres propio (Railway, local) no se tocan.
 */
export function toRuntimeDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!isSupabasePoolerHost(parsed.hostname)) return url;
  if (parsed.port === SUPABASE_TRANSACTION_PORT) return url;

  const authority = `${parsed.hostname}:5432`;
  if (!url.includes(authority)) return url;
  return url.replace(authority, `${parsed.hostname}:${SUPABASE_TRANSACTION_PORT}`);
}

/** `true` si la URL ya usa el pooler en modo transacción. */
export function isTransactionPoolerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isSupabasePoolerHost(parsed.hostname) && parsed.port === SUPABASE_TRANSACTION_PORT;
  } catch {
    return false;
  }
}
