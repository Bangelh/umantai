import { sql } from '@vercel/postgres';

// Type for product overrides stored in DB
export interface ProductOverrideRow {
  slug: string;
  data: Record<string, any>; // price, inStock, description, images, etc.
  updated_at: string;
}

/**
 * Returns the best available Postgres connection string.
 * Prefers the non-pooling URL for local development (more reliable).
 */
function getDatabaseUrl(): string | undefined {
  return (
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL
  );
}

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