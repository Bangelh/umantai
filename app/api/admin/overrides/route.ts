import { NextRequest, NextResponse } from 'next/server';
import { getAllOverrides, upsertOverride, deleteAllOverrides } from '@/lib/db';

/**
 * GET /api/admin/overrides
 * Returns all published product overrides from Vercel Postgres.
 */
export async function GET() {
  try {
    const overrides = await getAllOverrides();
    return NextResponse.json({ overrides });
  } catch (error) {
    console.error('Failed to load overrides from DB:', error);
    return NextResponse.json({ overrides: {}, error: 'Database error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/overrides
 * Publishes the current overrides to Vercel Postgres.
 * Body: { overrides: Record<string, any> }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { overrides } = body;

    if (!overrides || typeof overrides !== 'object') {
      return NextResponse.json({ error: 'Invalid overrides data' }, { status: 400 });
    }

    // Clear existing and insert new ones (simple full replace for now)
    await deleteAllOverrides();

    for (const [slug, data] of Object.entries(overrides)) {
      await upsertOverride(slug as string, data as Record<string, any>);
    }

    return NextResponse.json({
      success: true,
      message: 'Overrides published to Vercel Postgres successfully',
      count: Object.keys(overrides).length,
    });
  } catch (error: any) {
    console.error('Failed to publish overrides to Postgres:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to save to database' },
      { status: 500 }
    );
  }
}