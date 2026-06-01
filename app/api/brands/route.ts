import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { hasDatabaseConnection, getDatabaseNotConfiguredError } from '@/lib/db';

// GET all brands
export async function GET() {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  try {
    const result = await sql`
      SELECT id, name, created_at, updated_at 
      FROM brands 
      ORDER BY name
    `;
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST - Create new brand
export async function POST(request: NextRequest) {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
    }

    const result = await sql`
      INSERT INTO brands (name) 
      VALUES (${name}) 
      RETURNING *
    `;

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') { // unique violation
      return NextResponse.json({ success: false, error: 'Brand already exists' }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
