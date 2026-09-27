import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { baseProductsData, getProductOptions } from '@/lib/products';
import { enumerateVariantKeys } from '@/lib/commerce';
import {
  applyInventoryMovement,
  getInventoryItem,
  isCommerceDbConfigured,
  listInventory,
  listLowStock,
  setReorderPoint,
} from '@/lib/commerce.server';

/**
 * /api/admin/inventory — operación de inventario para la tienda (requiere admin token).
 *
 *  GET  → inventario completo + alertas de stock bajo.
 *  POST → REGISTRO DE INGRESO de mercadería (o ajuste de punto de reorden).
 *
 * Todo cambio de cantidad pasa por `inventory_apply_movement()`; nunca hay UPDATE
 * directo de `quantity_*`. El punto de reorden es configuración, no stock, así que se
 * puede fijar por separado (no altera cantidades).
 *
 * 200 · 400 body inválido · 401/503 auth · 500 fallo · 503 sin base.
 */

function badRequest(message: string) {
  return NextResponse.json({ ok: false, code: 'invalid_request', error: message }, { status: 400 });
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

  try {
    const [items, lowStock] = await Promise.all([listInventory(), listLowStock()]);
    return NextResponse.json(
      { ok: true, items, lowStock, generatedAt: new Date().toISOString() },
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

interface ReceiptBody {
  productSlug?: unknown;
  variantKey?: unknown;
  quantity?: unknown;
  reason?: unknown;
  reorderPoint?: unknown;
}

export async function POST(request: NextRequest) {
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

  let body: ReceiptBody;
  try {
    body = (await request.json()) as ReceiptBody;
  } catch {
    return badRequest('Solicitud inválida.');
  }

  const productSlug = typeof body.productSlug === 'string' ? body.productSlug.trim() : '';
  if (!productSlug) return badRequest('productSlug es obligatorio.');

  const base = baseProductsData.find((product) => product.slug === productSlug);
  if (!base) return badRequest(`Producto desconocido: "${productSlug}".`);

  // La variante debe ser una de las combinaciones reales del producto. Producto sin
  // opciones usa `variant_key = ''`.
  const options = getProductOptions(base);
  const validKeys = enumerateVariantKeys(options);
  const variantKey = typeof body.variantKey === 'string' ? body.variantKey.trim() : '';
  if (!validKeys.includes(variantKey)) {
    return badRequest(`Variante inválida para "${productSlug}": "${variantKey}".`);
  }

  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return badRequest('quantity debe ser un entero mayor que 0.');
  }

  const reason =
    typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'merchandise receipt';

  let reorderPoint: number | undefined;
  if (body.reorderPoint !== undefined && body.reorderPoint !== null) {
    const value = Number(body.reorderPoint);
    if (!Number.isInteger(value) || value < 0) {
      return badRequest('reorderPoint debe ser un entero mayor o igual que 0.');
    }
    reorderPoint = value;
  }

  try {
    // Ingreso de mercadería: SIEMPRE por el motor de inventario (ledger + anti-sobreventa).
    await applyInventoryMovement({
      productSlug,
      variantKey,
      movementType: 'receipt',
      onHandDelta: quantity,
      reason,
      performedBy: 'admin',
    });

    if (reorderPoint !== undefined) {
      await setReorderPoint(productSlug, variantKey, reorderPoint);
    }

    const item = await getInventoryItem(productSlug, variantKey);
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    console.error('[admin/inventory] no se pudo registrar el ingreso', { productSlug, variantKey, error });
    return NextResponse.json(
      { ok: false, code: 'receipt_failed', error: 'No se pudo registrar el ingreso de mercadería.' },
      { status: 500 },
    );
  }
}
