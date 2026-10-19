import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { isCommerceDbConfigured, listInventoryLedger } from '@/lib/commerce.server';
import { parseLedgerQuery } from '@/lib/inventory-admin';
import { baseProductsData } from '@/lib/products';

/**
 * GET /api/admin/inventory/ledger — movimientos de inventario (global, read-only).
 *
 * Filtros:
 *   product   slug
 *   variant   variant_key
 *   type      receipt | reservation | reservation_release | sale | adjustment |
 *             recount | return | shrinkage | transfer_in | transfer_out
 *   order     número de pedido (UM-…) o UUID
 *   from,to   YYYY-MM-DD o ISO 8601 (inclusivos)
 *   limit     1..200 (default 50) · offset ≥ 0
 *
 * Devuelve el saldo resultante (`onHandAfter`, `reservedAfter`) y el pedido
 * relacionado. No expone tokens, PIN ni metadata de pago.
 */
export async function GET(request: NextRequest) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, code: access.code, error: access.message },
      { status: access.status },
    );
  }

  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
      { status: 503 },
    );
  }

  const parsed = parseLedgerQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_query', error: parsed.error },
      { status: 400 },
    );
  }

  try {
    const page = await listInventoryLedger(parsed.value);
    const names = new Map(baseProductsData.map((product) => [product.slug, product.name]));

    return NextResponse.json(
      {
        ok: true,
        entries: page.entries.map((entry) => ({
          ...entry,
          productName: names.get(entry.productSlug) ?? entry.productSlug,
        })),
        hasMore: page.hasMore,
        limit: page.limit,
        offset: page.offset,
        filters: parsed.value,
        generatedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin/inventory/ledger] no se pudo leer el ledger', error);
    return NextResponse.json(
      { ok: false, code: 'ledger_unavailable', error: 'No se pudo cargar el historial de movimientos.' },
      { status: 500 },
    );
  }
}
