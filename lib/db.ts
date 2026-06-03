import { neon } from '@neondatabase/serverless';

// Type for product overrides stored in DB
export interface ProductOverrideRow {
  slug: string;
  data: Record<string, any>; // price, inStock, description, images, etc.
  updated_at: string;
}

/**
 * Returns the best available Postgres connection string.
 * Prefers the non-pooling URL for local development and serverless reliability.
 * This addresses the "pooled connection" warning on Vercel/Neon.
 */
function getDatabaseUrl(): string | undefined {
  return (
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL
  );
}

/**
 * Neon SQL client (replacement for deprecated @vercel/postgres).
 * Returns results in { rows: [...] } shape for minimal code changes in callers.
 */
function getSql() {
  const url = getDatabaseUrl();
  if (!url) return null;
  const neonSql = neon(url);
  // Wrap the tagged template call to return the old { rows } shape
  return (strings: TemplateStringsArray, ...values: any[]) => {
    return neonSql(strings, ...values).then((rows: any[]) => ({ rows }));
  };
}

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
export async function getAllOverrides(): Promise<Record<string, Record<string, any>>> {
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

    const overrides: Record<string, Record<string, any>> = {};
    for (const row of result.rows) {
      overrides[row.slug as string] = row.data as Record<string, any>;
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
export async function getOverride(slug: string): Promise<Record<string, any> | null> {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) return null;

  try {
    const result = await sql`
      SELECT data FROM product_overrides WHERE slug = ${slug} LIMIT 1
    `;
    if (result.rows.length === 0) return null;
    return result.rows[0].data as Record<string, any>;
  } catch (error) {
    console.error('[DB] Failed to fetch override for', slug, error);
    return null;
  }
}

/**
 * Upsert (insert or update) a single product override.
 */
export async function upsertOverride(slug: string, data: Record<string, any>): Promise<void> {
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