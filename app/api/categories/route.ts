import { NextRequest, NextResponse } from 'next/server';
import { sql, hasDatabaseConnection, getDatabaseNotConfiguredError } from '@/lib/db';

interface Category {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  level: number;
  sort_order: number;
  children?: Category[];
}

// GET /api/categories → returns flat list or tree
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format') || 'tree';

  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  try {
    const result = await sql`
      SELECT id, name, slug, parent_id, level, sort_order 
      FROM categories 
      ORDER BY level, sort_order, name
    `;

    const flatCategories = result.rows as Category[];

    if (format === 'flat') {
      return NextResponse.json({ success: true, data: flatCategories });
    }

    // Build tree
    const tree = buildCategoryTree(flatCategories);
    return NextResponse.json({ success: true, data: tree });
  } catch (error: any) {
    console.error('Error fetching categories:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST /api/categories → create new category/subcategory
export async function POST(request: NextRequest) {
  if (!hasDatabaseConnection()) {
    return NextResponse.json(getDatabaseNotConfiguredError(), { status: 503 });
  }

  try {
    const body = await request.json();
    const { name, parent_id = null } = body;

    if (!name) {
      return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
    }

    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    // Calculate level
    let level = 0;
    if (parent_id) {
      const parent = await sql`SELECT level FROM categories WHERE id = ${parent_id}`;
      level = (parent.rows[0]?.level || 0) + 1;
    }

    const result = await sql`
      INSERT INTO categories (name, slug, parent_id, level)
      VALUES (${name}, ${slug}, ${parent_id}, ${level})
      RETURNING *
    `;

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating category:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Helper to build tree from flat list
function buildCategoryTree(flat: Category[]): Category[] {
  const map = new Map<number, Category>();
  const roots: Category[] = [];

  flat.forEach(item => {
    map.set(item.id, { ...item, children: [] });
  });

  flat.forEach(item => {
    const node = map.get(item.id)!;
    if (item.parent_id === null) {
      roots.push(node);
    } else {
      const parent = map.get(item.parent_id);
      if (parent) {
        parent.children!.push(node);
      }
    }
  });

  return roots;
}
