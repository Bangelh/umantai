import { NextRequest, NextResponse } from 'next/server';
import { upsertOverride } from '@/lib/db';
import { baseProductsData as baseProducts } from '@/lib/products';

interface UpdateProductBody {
  category_id?: number;
  subcategory_id?: number;
  category_path?: string;
  // We can also allow other fields in the future
  price?: number;
  inStock?: number;
  description?: string;
  images?: string[];
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

    // Build the override object
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

    // Allow updating other common fields too (for future use)
    if (body.price !== undefined) changes.price = body.price;
    if (body.inStock !== undefined) changes.inStock = body.inStock;
    if (body.description !== undefined) changes.description = body.description;
    if (body.images !== undefined) changes.images = body.images;

    if (Object.keys(changes).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid fields to update' },
        { status: 400 }
      );
    }

    // Save to Postgres via the existing override system
    await upsertOverride(slug, changes);

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
