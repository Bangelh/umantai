import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getPrefixedEnv } from '@/lib/env';

/**
 * POST /api/admin/setup-db
 * One-time setup: creates the product_overrides table in Vercel Postgres.
 * 
 * You should only need to call this once after creating your Vercel Postgres database.
 */
async function setupDatabase() {
  // Prefer non-pooling (matches lib/db.ts and recent neon migration).
  // Uses getPrefixedEnv for full support of BANGELH_, UMANTAI_URL_*, UMANTAI_* etc.
  const databaseUrl =
    getPrefixedEnv('POSTGRES_URL_NON_POOLING') ||
    getPrefixedEnv('POSTGRES_URL') ||
    getPrefixedEnv('DATABASE_URL');

  if (!databaseUrl) {
    return NextResponse.json(
      { error: 'No Postgres URL found. Set POSTGRES_URL_NON_POOLING (preferred) or POSTGRES_URL / DATABASE_URL. Run `vercel env pull .env.local`.' },
      { status: 400 }
    );
  }

  try {
    // Products overrides (existing)
    await sql`
      CREATE TABLE IF NOT EXISTS product_overrides (
        slug TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_product_overrides_updated_at 
      ON product_overrides (updated_at DESC)
    `;

    // Categories table - supports full tree editing
    await sql`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        level INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_categories_level ON categories(level);
    `;

    // Brands table - simple flat list for easy management
    await sql`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    return NextResponse.json({
      success: true,
      message: 'Database tables created successfully: product_overrides, categories, brands',
    });
  } catch (error: any) {
    console.error('Database setup error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create tables' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return setupDatabase();
}

export async function POST() {
  return setupDatabase();
}