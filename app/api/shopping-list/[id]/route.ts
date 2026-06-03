import { NextRequest, NextResponse } from 'next/server';
import { hasDatabaseConnection } from '@/lib/db';
import { supabaseServer as serviceSupabase } from '@/lib/supabase/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';

/**
 * PATCH /api/shopping-list/[id]
 * Update fields for an item belonging to the current authenticated user.
 * Body can include: quantity, notes, isChecked, sortOrder, unit, category, itemName
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!hasDatabaseConnection() || !serviceSupabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json();
    const { quantity, notes, isChecked, sortOrder, unit, category, itemName } = body;

    // Build update object with only provided fields (partial update)
    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (quantity !== undefined) updateData.quantity = quantity;
    if (notes !== undefined) updateData.notes = notes;
    if (isChecked !== undefined) updateData.is_checked = isChecked;
    if (sortOrder !== undefined) updateData.sort_order = sortOrder;
    if (unit !== undefined) updateData.unit = unit;
    if (category !== undefined) updateData.category = category;
    if (itemName !== undefined) updateData.item_name = itemName;

    const { data, error } = await supabase
      .from('shopping_list_items')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, user_id, item_name, quantity, unit, category, is_checked, notes, sort_order, created_at, updated_at')
      .single();

    if (error) {
      if (error.code === 'PGRST116' || !data) {
        return NextResponse.json({ error: "Item not found or not owned by user" }, { status: 404 });
      }
      throw error;
    }

    if (!data) {
      return NextResponse.json({ error: "Item not found or not owned by user" }, { status: 404 });
    }

    // map camel
    const updated = {
      id: data.id,
      userId: data.user_id,
      itemName: data.item_name,
      quantity: data.quantity,
      unit: data.unit,
      category: data.category,
      isChecked: data.is_checked,
      notes: data.notes,
      sortOrder: data.sort_order,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("PATCH /api/shopping-list/[id] error:", error);
    return NextResponse.json({ error: "Failed to update item" }, { status: 500 });
  }
}

/**
 * DELETE /api/shopping-list/[id]
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!hasDatabaseConnection() || !serviceSupabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { error } = await supabase
      .from('shopping_list_items')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/shopping-list/[id] error:", error);
    return NextResponse.json({ error: "Failed to delete item" }, { status: 500 });
  }
}
