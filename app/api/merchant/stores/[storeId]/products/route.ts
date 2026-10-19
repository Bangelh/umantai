/**
 * /api/merchant/stores/:storeId/products
 *
 *   GET  → catálogo de LA tienda (requiere membresía).
 *   POST → crea un StoreProduct propio o vinculado al catálogo maestro.
 *
 * El `storeId` de la URL NUNCA se confía: `requireStoreAccess` se ejecuta antes
 * de cualquier lectura/escritura. Una membresía de la tienda A no abre la B.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { createStoreProduct, listStoreProducts } from '@/lib/stores.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ storeId: string }>;
}

interface CreateProductBody {
  name?: unknown;
  slug?: unknown;
  brand?: unknown;
  category?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  priceCents?: unknown;
  unit?: unknown;
  masterProductId?: unknown;
  visible?: unknown;
  initialStock?: unknown;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }
  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { error: 'Base de datos no configurada.', code: 'db_not_configured' },
      { status: 503 },
    );
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
    return NextResponse.json(
      { error: 'Necesitas iniciar sesión.', code: 'not_authenticated' },
      { status: 401 },
    );
  }

  const body = await readJsonBody<CreateProductBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }

  const name = str(body.name);
  const priceCents = Number(body.priceCents);
  if (!name || !Number.isFinite(priceCents)) {
    return NextResponse.json(
      {
        error: 'name y priceCents son obligatorios (precio en centavos enteros).',
        code: 'invalid_store_input',
      },
      { status: 400 },
    );
  }

  const { storeId } = await context.params;

  try {
    const product = await createStoreProduct(user.id, storeId, {
      name,
      slug: str(body.slug) ?? undefined,
      brand: str(body.brand),
      category: str(body.category),
      description: str(body.description),
      imageUrl: str(body.imageUrl),
      priceCents: Math.round(priceCents),
      unit: str(body.unit) ?? 'unidad',
      masterProductId: str(body.masterProductId),
      visible: body.visible === undefined ? true : body.visible === true,
      initialStock: Number(body.initialStock ?? 0),
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
