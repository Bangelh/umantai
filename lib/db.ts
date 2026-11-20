import { createSqlClient } from './db-driver.server';
import { toRuntimeDatabaseUrl } from './db-url';
import { getPrefixedEnv } from './env';

// Type for product overrides stored in DB
export interface ProductOverrideRow {
  slug: string;
  data: Record<string, unknown>; // price, inStock, description, images, etc.
  updated_at: string;
}

/**
 * Returns the Postgres connection string for RUNTIME.
 *
 * En serverless la cadena correcta es el pooler de Supabase en modo transacción
 * (6543): el de sesión tiene un tope de `pool_size` clientes y, con un pool por
 * instancia, terminaba respondiendo `EMAXCONNSESSION` y 500 en la vitrina.
 * `toRuntimeDatabaseUrl` mueve una URL de sesión (5432) a transacción (6543) y
 * deja intactas la directa y cualquier Postgres propio.
 *
 * Las migraciones y los seeds NO pasan por acá: leen `POSTGRES_URL_NON_POOLING`
 * directamente, como indica DEPLOYMENT.md.
 */
export function getDatabaseUrl(): string | undefined {
  const raw =
    getPrefixedEnv('DATABASE_URL') ||
    getPrefixedEnv('POSTGRES_URL') ||
    getPrefixedEnv('POSTGRES_URL_NON_POOLING');
  if (!raw) return undefined;

  const url = toRuntimeDatabaseUrl(raw);

  // Solo queda sesión si la URL no era reconocible como pooler de Supabase.
  if (process.env.NODE_ENV === 'development' && /pooler\.supabase\.com:5432/.test(url)) {
    console.warn(
      '⚠️ [db] La conexión sigue en el pooler de sesión (5432). Usa la cadena de transacción (6543).',
    );
  }

  return url;
}

/**
 * SQL client portable (Neon HTTP o `pg`, según `DB_DRIVER`/host).
 * Mantiene el shape `{ rows }` que ya esperan los llamadores.
 */
function getSql() {
  const url = getDatabaseUrl();
  if (!url) return null;
  const client = createSqlClient(url);
  // Envuelve el tagged template para conservar el viejo shape `{ rows }`.
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    return client(strings, ...values).then((rows) => ({ rows }));
  };
}

// Algunas rutas legacy consumen `rowCount`/`query` de este tag; se mantiene
// deliberadamente sin tipar para no cambiar su comportamiento en esta fase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sql = getSql() as any; // local for internal use + re-export
export { sql }; // for direct import compatibility in routes that still do `import { sql } from ...`

/**
 * Returns true if a Postgres connection string is available.
 */
export function hasDatabaseConnection(): boolean {
  return !!getDatabaseUrl();
}

/**
 * Returns a user-friendly error when the database is not configured.
 */
export function getDatabaseNotConfiguredError() {
  return {
    error: "Database not configured",
    message:
      "No Postgres connection string found. " +
      "Run `vercel env pull .env.local`. " +
      "For local development, prefer using POSTGRES_URL_NON_POOLING if available.",
  };
}

/**
 * Get all product overrides from Vercel Postgres.
 * Falls back to empty object if no database is configured.
 */
export async function getAllOverrides(): Promise<Record<string, Record<string, unknown>>> {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    console.warn('[DB] No Postgres URL found. Using empty overrides.');
    return {};
  }

  try {
    const result = await sql`
      SELECT slug, data 
      FROM product_overrides
    `;

    const overrides: Record<string, Record<string, unknown>> = {};
    for (const row of result.rows) {
      overrides[row.slug as string] = row.data as Record<string, unknown>;
    }
    return overrides;
  } catch (error) {
    console.error('[DB] Failed to fetch overrides:', error);
    return {};
  }
}

/**
 * Get a single product's override data (or null if none).
 */
export async function getOverride(slug: string): Promise<Record<string, unknown> | null> {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) return null;

  try {
    const result = await sql`
      SELECT data FROM product_overrides WHERE slug = ${slug} LIMIT 1
    `;
    if (result.rows.length === 0) return null;
    return result.rows[0].data as Record<string, unknown>;
  } catch (error) {
    console.error('[DB] Failed to fetch override for', slug, error);
    return null;
  }
}

/**
 * Upsert (insert or update) a single product override.
 */
export async function upsertOverride(slug: string, data: Record<string, unknown>): Promise<void> {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    throw new Error('Cannot save to database: No Postgres URL configured');
  }

  await sql`
    INSERT INTO product_overrides (slug, data, updated_at)
    VALUES (${slug}, ${JSON.stringify(data)}::jsonb, NOW())
    ON CONFLICT (slug) 
    DO UPDATE SET 
      data = ${JSON.stringify(data)}::jsonb,
      updated_at = NOW()
  `;
}

/**
 * Delete a specific override (revert to base product data).
 */
export async function deleteOverride(slug: string): Promise<void> {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) return;

  await sql`
    DELETE FROM product_overrides 
    WHERE slug = ${slug}
  `;
}

/**
 * Delete all overrides (reset everything).
 */
export async function deleteAllOverrides(): Promise<void> {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) return;

  await sql`DELETE FROM product_overrides`;
}