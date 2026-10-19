/**
 * lib/platform-db.server.ts — un único cliente SQL para la capa de plataforma.
 *
 * Reutiliza el driver portable (Neon HTTP o `pg`) y mantiene el pool por
 * proceso. Separado de `lib/db.ts` (que conserva el shape legacy `{ rows }`)
 * para que el código nuevo use `Row[]` y transacciones tipadas.
 */

import { createSqlClient, type SqlClient } from './db-driver.server';
import { getDatabaseUrl } from './db';

let cachedSql: SqlClient | null = null;
let cachedUrl: string | null = null;

export function isPlatformDbConfigured(): boolean {
  return !!getDatabaseUrl();
}

export function getPlatformSql(): SqlClient | null {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedSql || cachedUrl !== url) {
    cachedSql = createSqlClient(url);
    cachedUrl = url;
  }
  return cachedSql;
}

export function requirePlatformSql(): SqlClient {
  const sql = getPlatformSql();
  if (!sql) throw new Error('platform_db_not_configured');
  return sql;
}

/** Número tolerante: `pg` devuelve BIGINT/NUMERIC como string. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = toNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return '';
}
