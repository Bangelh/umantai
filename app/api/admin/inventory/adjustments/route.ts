import { NextRequest, NextResponse } from 'next/server';
import { guardAdminMutation } from '@/lib/admin-route.server';
import { parseAdjustmentInput } from '@/lib/inventory-admin';
import { executeAdjustment, InventoryAdminError } from '@/lib/inventory-admin.server';

/**
 * POST /api/admin/inventory/adjustments — ajuste manual de stock físico.
 *
 * Body:
 *   {
 *     productSlug: string,
 *     variantKey?: string,
 *     delta: number,          // firmado y distinto de 0: + aumenta, − disminuye
 *     reason: string,          // OBLIGATORIO y auditable
 *     actor?: string,
 *     idempotencyKey?: string
 *   }
 *
 * `delta` (no "stock nuevo") evita el patrón leer→JS→escribir vulnerable a carreras.
 * Postgres rechaza el ajuste si dejara `on_hand < reserved` o `available < 0`.
 *
 * 200 · 400 validación · 401/503 auth · 409 invariante · 429 · 500.
 */
export async function POST(request: NextRequest) {
  const guard = await guardAdminMutation(request, 'inventory-adjustments');
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

  const parsed = parseAdjustmentInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request', error: parsed.error },
      { status: 400 },
    );
  }

  try {
    const result = await executeAdjustment(parsed.value);
    return NextResponse.json(
      {
        ok: true,
        item: result.item,
        movement: result.movement,
        before: result.before,
        after: {
          onHand: result.movement.onHandAfter,
          reserved: result.movement.reservedAfter,
          available: result.movement.onHandAfter - result.movement.reservedAfter,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof InventoryAdminError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    console.error('[admin/inventory/adjustments] fallo al ajustar stock', error);
    return NextResponse.json(
      { ok: false, code: 'adjustment_failed', error: 'No se pudo aplicar el ajuste.' },
      { status: 500 },
    );
  }
}
