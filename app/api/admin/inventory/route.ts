import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { guardAdminMutation } from '@/lib/admin-route.server';
import { baseProductsData } from '@/lib/products';
import {
  filterInventoryItems,
  parseInventoryListQuery,
  parseReceiptInput,
  parseThresholdInput,
  summarizeInventory,
  toAdminInventoryItem,
} from '@/lib/inventory-admin';
import { executeReceipt, executeThreshold, InventoryAdminError } from '@/lib/inventory-admin.server';
import { isCommerceDbConfigured, listInventory, listLowStock } from '@/lib/commerce.server';

/**
 * /api/admin/inventory — operación de inventario (requiere admin token).
 *
 *  GET   → inventario enriquecido con nombre/marca/estado + resumen + alertas.
 *          Filtros opcionales: ?q= &status=available|low|out|all &variant= &limit=
 *  POST  → compatibilidad: registra un ingreso (delegado a /receipts).
 *  PATCH → configura el umbral de stock bajo (`reorder_point`) de un SKU.
 *
 * Todo cambio de cantidad pasa por `inventory_apply_movement()`; el umbral es
 * configuración (no stock) y no altera cantidades.
 */

function catalogMap() {
  return new Map(baseProductsData.map((product) => [product.slug, product]));
}

export async function GET(request: NextRequest) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json({ ok: false, code: access.code, error: access.message }, { status: access.status });
  }

  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
      { status: 503 },
    );
  }

  const parsed = parseInventoryListQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_query', error: parsed.error },
      { status: 400 },
    );
  }

  try {
    const [items, lowStockRaw] = await Promise.all([
      listInventory('MAIN', parsed.value.limit),
      listLowStock('MAIN'),
    ]);

    const catalog = catalogMap();
    const enriched = items.map((item) => toAdminInventoryItem(item, catalog.get(item.productSlug)));
    const lowStock = lowStockRaw.map((item) =>
      toAdminInventoryItem(item, catalog.get(item.productSlug)),
    );

    const filtered = filterInventoryItems(enriched, parsed.value.filters);

    return NextResponse.json(
      {
        ok: true,
        items: filtered,
        lowStock,
        summary: summarizeInventory(enriched),
        filters: parsed.value.filters,
        generatedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin/inventory] no se pudo leer el inventario', error);
    return NextResponse.json(
      { ok: false, code: 'inventory_unavailable', error: 'No se pudo cargar el inventario.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = guardAdminMutation(request, 'inventory-legacy-receipt');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_json', error: 'Solicitud inválida.' },
      { status: 400 },
    );
  }

  const parsed = parseReceiptInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request', error: parsed.error },
      { status: 400 },
    );
  }

  try {
    const result = await executeReceipt(parsed.value);
    return NextResponse.json(
      { ok: true, item: result.item, movement: result.movement, thresholdWarning: result.thresholdWarning },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof InventoryAdminError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    console.error('[admin/inventory] no se pudo registrar el ingreso', error);
    return NextResponse.json(
      { ok: false, code: 'receipt_failed', error: 'No se pudo registrar el ingreso de mercadería.' },
      { status: 500 },
    );
  }
}

/** PATCH /api/admin/inventory — umbral de stock bajo (reorder_point). */
export async function PATCH(request: NextRequest) {
  const guard = guardAdminMutation(request, 'inventory-threshold');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_json', error: 'Solicitud inválida.' },
      { status: 400 },
    );
  }

  const parsed = parseThresholdInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request', error: parsed.error },
      { status: 400 },
    );
  }

  try {
    const item = await executeThreshold(parsed.value);
    return NextResponse.json({ ok: true, item }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof InventoryAdminError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    console.error('[admin/inventory] no se pudo guardar el umbral', error);
    return NextResponse.json(
      { ok: false, code: 'threshold_failed', error: 'No se pudo guardar el umbral.' },
      { status: 500 },
    );
  }
}
