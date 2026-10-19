/**
 * /api/admin/master-products — Platform Admin (catálogo maestro).
 *
 *   GET   → listar/buscar (incluye archivados con ?includeArchived=1)
 *   POST  → crear (evita duplicados por nombre+marca)
 *   PATCH → editar/publicar/archivar por id
 *
 * Protegida por `ADMIN_API_SECRET`. NO es el panel del merchant: un merchant
 * nunca debe poder modificar el catálogo global desde su sesión.
 */

import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { CatalogError } from '@/lib/catalog';
import {
  createMasterProduct,
  listMasterProducts,
  updateMasterProduct,
} from '@/lib/master.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminError(access: { status: number; code: string; message: string }) {
  return NextResponse.json({ error: access.message, code: access.code }, { status: access.status });
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) return adminError(access);

  const params = new URL(request.url).searchParams;
  try {
    const result = await listMasterProducts({
      q: params.get('q') ?? '',
      category: params.get('category'),
      brand: params.get('brand'),
      includeArchived: params.get('includeArchived') === '1',
      limit: Number(params.get('limit') ?? 50),
      offset: Number(params.get('offset') ?? 0),
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

interface MasterBody {
  name?: unknown;
  slug?: unknown;
  brand?: unknown;
  category?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  attributes?: unknown;
}

export async function POST(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) return adminError(access);

  const body = await readJsonBody<MasterBody>(request);
  if (!body) {
    return NextResponse.json({ error: 'JSON inválido.', code: 'invalid_json' }, { status: 400 });
  }
  const name = str(body.name);
  if (!name) {
    return NextResponse.json({ error: 'El nombre es obligatorio.', code: 'invalid_master_product' }, { status: 400 });
  }

  try {
    const product = await createMasterProduct({
      name,
      slug: str(body.slug),
      brand: str(body.brand),
      category: str(body.category),
      description: str(body.description),
      imageUrl: str(body.imageUrl),
      attributes:
        body.attributes && typeof body.attributes === 'object'
          ? (body.attributes as Record<string, unknown>)
          : {},
    });
    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const access = requireAdminToken(request);
  if (!access.ok) return adminError(access);

  const body = await readJsonBody<MasterBody & { id?: unknown; archived?: unknown; active?: unknown }>(request);
  if (!body || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'id es obligatorio.', code: 'invalid_master_product' }, { status: 400 });
  }

  try {
    const product = await updateMasterProduct(body.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      brand: typeof body.brand === 'string' ? body.brand : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : undefined,
      attributes:
        body.attributes && typeof body.attributes === 'object'
          ? (body.attributes as Record<string, unknown>)
          : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
      archived: body.archived === true,
    });
    return NextResponse.json({ product });
  } catch (error) {
    if (error instanceof CatalogError) return platformErrorResponse(error);
    return platformErrorResponse(error);
  }
}
