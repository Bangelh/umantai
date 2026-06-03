import { NextRequest, NextResponse } from 'next/server';
import { sql, hasDatabaseConnection, getDatabaseNotConfiguredError } from '@/lib/db';

// PATCH /api/categories/[id] - Rename or move
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  const { id } = await params;
  const categoryId = parseInt(id);

  try {
    const body = await request.json();
    const { name, parent_id } = body;

    const updates: string[] = [];
    const values: any[] = [];

    if (name !== undefined) {
      updates.push(`name = $${values.length + 1}`);
      values.push(name);
    }

    if (parent_id !== undefined) {
      updates.push(`parent_id = $${values.length + 1}`);
      values.push(parent_id === null ? null : parseInt(parent_id));
    }

    if (updates.length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 });
    }

    updates.push(`updated_at = NOW()`);

    const query = `
      UPDATE categories 
      SET ${updates.join(', ')} 
      WHERE id = $${values.length + 1}
      RETURNING *
    `;
    values.push(categoryId);

    const result = await sql.query(query, values);

    if (result.rowCount === 0) {
      return NextResponse.json({ success: false, error: 'Category not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating category:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// DELETE /api/categories/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  const { id } = await params;
  const categoryId = parseInt(id);

  try {
    // Check if category has children
    const childrenCheck = await sql`
      SELECT COUNT(*) as count FROM categories WHERE parent_id = ${categoryId}
    `;

    if (parseInt(childrenCheck.rows[0].count) > 0) {
      return NextResponse.json(
        { success: false, error: 'Cannot delete category that has subcategories. Delete children first.' },
        { status: 400 }
      );
    }

    const result = await sql`
      DELETE FROM categories WHERE id = ${categoryId}
    `;

    if (result.rowCount === 0) {
      return NextResponse.json({ success: false, error: 'Category not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'Category deleted' });
  } catch (error: any) {
    console.error('Error deleting category:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
