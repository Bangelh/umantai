import { NextRequest, NextResponse } from 'next/server';
import { hasDatabaseConnection } from '@/lib/db';
import { supabaseServer as serviceSupabase } from '@/lib/supabase/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';

/**
 * GET /api/shopping-list
 * Returns items for the authenticated user.
 */
export async function GET(req: NextRequest) {
  if (!hasDatabaseConnection() || !serviceSupabase) {
    return NextResponse.json({ items: [], warning: "Database not configured (list is local-only for now)" });
  }

  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ items: [], error: "Authentication required. Please sign in to use the shopping list." }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('shopping_list_items')
      .select('id, user_id, item_name, quantity, unit, category, is_checked, notes, sort_order, created_at, updated_at')
      .eq('user_id', user.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Map snake to camelCase to match new API contract
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
    console.error("GET /api/shopping-list error:", error);
    const msg = error?.message || "";
    if (msg.includes("relation") || msg.includes("does not exist") || (error?.code === '42P01')) {
      return NextResponse.json(
        { items: [], error: "shopping_list_items table missing. Run the 'Setup Category & Brand Tables' (or full setup) button in /admin." },
        { status: 503 }
      );
    }
    return NextResponse.json({ items: [], error: "Failed to load shopping list" }, { status: 500 });
  }
}

/**
 * POST /api/shopping-list
 * Body: { itemName: string, quantity?: number, notes?: string | null, unit?: string, category?: string }
 */
export async function POST(req: NextRequest) {
  if (!hasDatabaseConnection() || !serviceSupabase) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required. Please sign in to add items to your list." }, { status: 401 });
    }

    const body = await req.json();
    const { itemName, quantity = 1, notes = null, unit = null, category = null } = body;

    if (!itemName || typeof itemName !== "string") {
      return NextResponse.json({ error: "itemName is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('shopping_list_items')
      .insert({
        user_id: user.id,
        item_name: itemName,
        quantity,
        notes,
        unit,
        category,
        sort_order: Date.now(),
        is_checked: false,
      })
      .select('id, user_id, item_name, quantity, unit, category, is_checked, notes, sort_order, created_at, updated_at')
      .single();

    if (error) throw error;

    // map to camelCase response
    const item = data ? {
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
    } : null;

    return NextResponse.json(item);
  } catch (error: any) {
    console.error("POST /api/shopping-list error:", error);
    const msg = error?.message || "";
    if (msg.includes("relation") || msg.includes("does not exist") || (error?.code === '42P01')) {
      return NextResponse.json(
        { error: "shopping_list_items table missing. Use the Setup button in /admin first." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: "Failed to add item" }, { status: 500 });
  }
}
