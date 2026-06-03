import { NextRequest, NextResponse } from 'next/server';
import { upsertOverride, getOverride } from '@/lib/db';
import { baseProductsData as baseProducts } from '@/lib/products';

interface UpdateProductBody {
  // Category tree selection (for DB tracking)
  category_id?: number;
  subcategory_id?: number;
  category_path?: string;

  // Full editable product fields (for rename, inventory, etc)
  name?: string;
  price?: number;
  inStock?: number;
  description?: string;
  brand?: string;
  category?: string;
  subcategory?: string;
  images?: string[];
  rating?: number;
  reviewCount?: number;
  bestseller?: boolean;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  try {
    const body: UpdateProductBody = await request.json();

    // Verify the product exists in base data
    const baseProduct = baseProducts.find((p) => p.slug === slug);
    if (!baseProduct) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 }
      );
    }

    // Build the override object (support rename + all edit fields + inventory)
    const changes: Record<string, any> = {};

    if (body.category_id !== undefined) {
      changes.category_id = body.category_id;
    }
    if (body.subcategory_id !== undefined) {
      changes.subcategory_id = body.subcategory_id;
    }
    if (body.category_path) {
      changes.category_path = body.category_path;
    }

    if (body.name !== undefined) changes.name = body.name;
    if (body.price !== undefined) changes.price = body.price;
    if (body.inStock !== undefined) changes.inStock = body.inStock;
    if (body.description !== undefined) changes.description = body.description;
    if (body.brand !== undefined) changes.brand = body.brand;
    if (body.category !== undefined) changes.category = body.category;
    if (body.subcategory !== undefined) changes.subcategory = body.subcategory;
    if (body.images !== undefined) changes.images = body.images;
    if (body.rating !== undefined) changes.rating = body.rating;
    if (body.reviewCount !== undefined) changes.reviewCount = body.reviewCount;
    if (body.bestseller !== undefined) changes.bestseller = body.bestseller;

    if (Object.keys(changes).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid fields to update' },
        { status: 400 }
      );
    }

    // Merge with existing to avoid partial PATCH (e.g. stock update) wiping prior rename/name/brand etc.
    const existing = await getOverride(slug);
    const merged = existing ? { ...existing, ...changes } : changes;

    // Save to Postgres via the existing override system
    await upsertOverride(slug, merged);

    return NextResponse.json({
      success: true,
      message: 'Product updated successfully',
      slug,
      updated_fields: Object.keys(changes),
    });
  } catch (error: any) {
    console.error('Error updating product:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to update product' },
      { status: 500 }
    );
  }
}

// Also support PUT for clients that prefer it
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const resolvedParams = { params: await params };
  return PATCH(request, resolvedParams as any);
}
