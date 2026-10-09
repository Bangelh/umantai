import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { isCommerceDbConfigured, listInventory } from '@/lib/commerce.server';
import {
  buildReceiptPlan,
  enumerateCatalogCombinations,
} from '@/lib/inventory-receipt-plan';
import { baseProductsData } from '@/lib/products';

/**
 * GET /api/admin/inventory/receipt-plan — auditoría READ-ONLY para preparar stock.
 *
 * Cruza TODAS las combinaciones activas del catálogo (`baseProductsData`) contra las
 * filas reales de `inventory`, y calcula cuánto recibir para dejar cada SKU en
 * `quantityAvailable = target`. Incluye combinaciones SIN fila (0/0/0 → faltan `target`).
 *
 * Query:
 *   ?target=10     (objetivo de `quantityAvailable`; entero 0..100000, por defecto 10)
 *   ?location=MAIN (opcional)
 *
 * Salida: `{ ok, target, locationCode, rows[], summary{}, generatedAt }`.
 *
 * SOLO LECTURA. No escribe `inventory`, no toca `reserved`, no crea pedidos y NO
 * ejecuta receipts (para eso se usa `POST /api/admin/inventory`, uno por SKU).
 *
 * 200 con datos · 400 parámetro inválido · 401/503 auth · 503 sin base · 500 fallo.
 */

const DEFAULT_TARGET = 10;
const MAX_TARGET = 100_000;

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

  let target = DEFAULT_TARGET;
  const rawTarget = request.nextUrl.searchParams.get('target');
  if (rawTarget !== null) {
    const parsed = Number(rawTarget);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_TARGET) {
      return NextResponse.json(
        {
          ok: false,
          code: 'invalid_target',
          error: `target debe ser un entero entre 0 y ${MAX_TARGET}.`,
        },
        { status: 400 },
      );
    }
    target = parsed;
  }

  const rawLocation = request.nextUrl.searchParams.get('location');
  const locationCode = rawLocation && rawLocation.trim() ? rawLocation.trim() : 'MAIN';

  try {
    const inventory = await listInventory(locationCode);
    const combinations = enumerateCatalogCombinations(baseProductsData);
    const plan = buildReceiptPlan(combinations, inventory, target);

    return NextResponse.json(
      {
        ok: true,
        target,
        locationCode,
        rows: plan.rows,
        summary: plan.summary,
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin/inventory/receipt-plan] no se pudo construir el plan', error);
    return NextResponse.json(
      { ok: false, code: 'receipt_plan_unavailable', error: 'No se pudo construir el plan de recepción.' },
      { status: 500 },
    );
  }
}
