import { NextRequest, NextResponse } from 'next/server';
import { guardAdminMutation } from '@/lib/admin-route.server';
import { parseReceiptInput } from '@/lib/inventory-admin';
import { executeReceipt, InventoryAdminError } from '@/lib/inventory-admin.server';

/**
 * POST /api/admin/inventory/receipts — entrada de mercadería.
 *
 * Body:
 *   {
 *     productSlug: string,
 *     variantKey?: string,          // '' para productos sin variantes
 *     quantity: number,             // entero > 0
 *     reason?: string,              // referencia/factura/proveedor
 *     actor?: string,               // quién lo registra (default "admin")
 *     reorderPoint?: number,        // umbral opcional de stock bajo
 *     idempotencyKey?: string       // evita duplicar por reintento/doble clic
 *   }
 *
 * El movimiento lo escribe `inventory_apply_movement()` (atómico, con ledger).
 * Nunca se hace UPDATE directo de `inventory.quantity_on_hand`.
 *
 * 201 · 400 validación · 401/503 auth · 409 invariante · 429 rate limit · 500.
 */
export async function POST(request: NextRequest) {
  const guard = await guardAdminMutation(request, 'inventory-receipts');
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
    const before = {
      onHand: result.movement.onHandAfter - result.movement.onHandDelta,
      reserved: result.movement.reservedAfter - result.movement.reservedDelta,
    };

    return NextResponse.json(
      {
        ok: true,
        item: result.item,
        movement: result.movement,
        before,
        thresholdWarning: result.thresholdWarning,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof InventoryAdminError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    console.error('[admin/inventory/receipts] fallo al registrar ingreso', error);
    return NextResponse.json(
      { ok: false, code: 'receipt_failed', error: 'No se pudo registrar el ingreso de mercadería.' },
      { status: 500 },
    );
  }
}
