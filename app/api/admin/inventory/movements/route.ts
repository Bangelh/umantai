import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { isCommerceDbConfigured, listInventoryMovements } from '@/lib/commerce.server';

/**
 * GET /api/admin/inventory/movements — auditoría READ-ONLY del ledger de un SKU.
 *
 * Existe para reconciliar `inventory.quantity_reserved` contra `inventory_movements`
 * cuando ambos no cuadran (una reserva "varada": el inventario dice `reserved = 1`
 * pero ningún pedido aparece como titular). Devuelve la secuencia completa de
 * movimientos y, derivado, en qué punto exacto diverge el ledger del inventario.
 *
 * Query:
 *   ?product=dyson-v15-detect   (obligatorio)
 *   ?variant=<variant_key>      (opcional; sin él se auditan TODAS las variantes)
 *   ?location=MAIN              (opcional; por defecto MAIN)
 *   ?limit=500                  (1..2000)
 *
 * Salida: `{ ok, productSlug, inventory[], reconciliations[], lines[], unattributed,
 *            movements[], orders[], generatedAt }`.
 *
 * SOLO LECTURA. NUNCA expone `public_token`, PIN, `payment_reference`, `idempotency_key`
 * de pedidos ni `metadata` cruda: los movimientos y el contexto de pedido son datos de
 * auditoría de inventario, no de pago.
 *
 * 200 con datos · 400 parámetro inválido · 401/503 auth · 503 sin base · 500 fallo.
 */

const MOVEMENTS_MAX_LIMIT = 2000;

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

  const productSlug = (request.nextUrl.searchParams.get('product') ?? '').trim();
  if (!productSlug) {
    return NextResponse.json(
      { ok: false, code: 'missing_product', error: 'El parámetro `product` es obligatorio.' },
      { status: 400 },
    );
  }

  const rawVariant = request.nextUrl.searchParams.get('variant');
  const variantKey = rawVariant && rawVariant.trim() ? rawVariant.trim() : undefined;

  const rawLocation = request.nextUrl.searchParams.get('location');
  const locationCode = rawLocation && rawLocation.trim() ? rawLocation.trim() : undefined;

  const rawLimit = request.nextUrl.searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MOVEMENTS_MAX_LIMIT) {
      return NextResponse.json(
        {
          ok: false,
          code: 'invalid_limit',
          error: `limit debe ser un entero entre 1 y ${MOVEMENTS_MAX_LIMIT}.`,
        },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  try {
    const audit = await listInventoryMovements({ productSlug, variantKey, locationCode, limit });

    return NextResponse.json(
      { ok: true, ...audit, generatedAt: new Date().toISOString() },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin/inventory/movements] no se pudo leer el ledger', error);
    return NextResponse.json(
      { ok: false, code: 'movements_unavailable', error: 'No se pudo cargar el ledger de inventario.' },
      { status: 500 },
    );
  }
}
