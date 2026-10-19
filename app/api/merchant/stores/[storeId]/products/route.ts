/**
 * /api/merchant/stores/:storeId/products
 *
 *   GET  → catálogo de LA tienda (productos + variantes + stock).
 *   POST → crea un producto propio o desde el catálogo maestro, con variantes.
 *
 * El `storeId` de la URL NUNCA se confía: `requireStoreAccess` corre dentro de
 * cada función antes de leer/escribir. Una membresía de A no abre B.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { CatalogError, type CatalogVariantInput } from '@/lib/catalog';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { createStoreProductCatalog } from '@/lib/store-catalog.server';
import { listStoreProducts } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface CreateProductBody {
  name?: unknown;
  slug?: unknown;
  masterProductId?: unknown;
  brand?: unknown;
  category?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  priceCents?: unknown;
  unit?: unknown;
  visible?: unknown;
  initialStock?: unknown;
  variants?: unknown;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseVariants(value: unknown): CatalogVariantInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CatalogError('invalid_variant', 'variants debe ser una lista.');
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new CatalogError('invalid_variant', 'Cada variante debe ser un objeto.');
    }
    const item = raw as Record<string, unknown>;
    return {
      optionValues:
        item.optionValues && typeof item.optionValues === 'object'
          ? (item.optionValues as Record<string, unknown>)
          : {},
      sku: str(item.sku),
      priceCents:
        item.priceCents === null || item.priceCents === undefined
          ? null
          : Math.round(Number(item.priceCents)),
      initialStock: Number(item.initialStock ?? 0),
      active: item.active !== false,
    };
  });
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }
  if (!isPlatformDbConfigured()) {
    return NextResponse.json({ error: 'Base de datos no configurada.', code: 'db_not_configured' }, { status: 503 });
  }

  const { storeId } = await context.params;
  try {
    return NextResponse.json({ products: await listStoreProducts(user.id, storeId) });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.', code: 'not_authenticated' }, { status: 401 });
  }

  const body = await readJsonBody<CreateProductBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  const priceCents = Number(body.priceCents);
  if (!Number.isFinite(priceCents)) {
    return NextResponse.json(
      { error: 'priceCents es obligatorio (centavos enteros).', code: 'invalid_product' },
      { status: 400 },
    );
  }

  const { storeId } = await context.params;

  try {
    const variants = parseVariants(body.variants);
    const created = await createStoreProductCatalog(user.id, storeId, {
      name: str(body.name),
      slug: str(body.slug),
      masterProductId: str(body.masterProductId),
      brand: str(body.brand),
      category: str(body.category),
      description: str(body.description),
      imageUrl: str(body.imageUrl),
      priceCents: Math.round(priceCents),
      unit: str(body.unit) ?? 'unidad',
      visible: body.visible === undefined ? true : body.visible === true,
      initialStock: Number(body.initialStock ?? 0),
      variants,
    });

    const products = await listStoreProducts(user.id, storeId);
    const product = products.find((item) => item.id === String(created.id)) ?? null;
    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
