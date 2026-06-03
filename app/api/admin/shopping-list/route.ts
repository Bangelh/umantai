import { NextResponse } from 'next/server';
import { hasDatabaseConnection } from '@/lib/db';
import { supabaseServer } from '@/lib/supabase/server';

/**
 * GET /api/admin/shopping-list
 * Admin view: returns ALL shopping list items across all users (bypasses RLS via service role).
 * No auth here (protected by /admin password gate in UI).
 * Use only from the admin panel.
 */
export async function GET() {
  if (!hasDatabaseConnection() || !supabaseServer) {
    return NextResponse.json({ items: [], error: "Database not configured" }, { status: 503 });
  }

  try {
    const { data, error } = await supabaseServer
      .from('shopping_list_items')
      .select('id, user_id, item_name, quantity, unit, category, is_checked, notes, sort_order, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    const items = (data || []).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      itemName: row.item_name,
      quantity: row.quantity,
      unit: row.unit,
      category: row.category,
      isChecked: row.is_checked,
      notes: row.notes,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return NextResponse.json({ items });
  } catch (error: any) {
    console.error("Admin shopping list fetch error:", error);
    const msg = error?.message || "";
    if (msg.includes("relation") || msg.includes("does not exist") || (error?.code === '42P01')) {
      return NextResponse.json(
        { items: [], error: "shopping_list_items table missing. Click Setup in /admin." },
        { status: 503 }
      );
    }
    return NextResponse.json({ items: [], error: "Failed to fetch items" }, { status: 500 });
  }
}

// PATCH for admin (bypass RLS)
export async function PATCH(req: Request) {
  if (!hasDatabaseConnection() || !supabaseServer) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  try {
    const { id, ...updates } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    // map camel to snake for db
    const dbUpdates: any = { updated_at: new Date().toISOString() };
    if (updates.quantity !== undefined) dbUpdates.quantity = updates.quantity;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    if (updates.isChecked !== undefined) dbUpdates.is_checked = updates.isChecked;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    if (updates.unit !== undefined) dbUpdates.unit = updates.unit;
    if (updates.category !== undefined) dbUpdates.category = updates.category;
    if (updates.itemName !== undefined) dbUpdates.item_name = updates.itemName;

    const { data, error } = await supabaseServer
      .from('shopping_list_items')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'update failed' }, { status: 500 });
  }
}

// DELETE for admin
export async function DELETE(req: Request) {
  if (!hasDatabaseConnection() || !supabaseServer) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabaseServer.from('shopping_list_items').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'delete failed' }, { status: 500 });
  }
}
