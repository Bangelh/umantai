import { NextRequest, NextResponse } from 'next/server';
import { sql, hasDatabaseConnection, getDatabaseNotConfiguredError } from '@/lib/db';

// PATCH - Rename brand
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  const { id } = await params;
  const brandId = parseInt(id);

  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
    }

    const result = await sql`
      UPDATE brands 
      SET name = ${name}, updated_at = NOW() 
      WHERE id = ${brandId} 
      RETURNING *
    `;

    if (result.rowCount === 0) {
      return NextResponse.json({ success: false, error: 'Brand not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return NextResponse.json({ success: false, error: 'Brand name already exists' }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// DELETE brand
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  const { id } = await params;
  const brandId = parseInt(id);

  try {
    const result = await sql`
      DELETE FROM brands WHERE id = ${brandId}
    `;

    if (result.rowCount === 0) {
      return NextResponse.json({ success: false, error: 'Brand not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'Brand deleted' });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
