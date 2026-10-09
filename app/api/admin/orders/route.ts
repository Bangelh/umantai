import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { isCommerceDbConfigured } from '@/lib/commerce.server';
import { QA_CLEANUP_TARGET_STATUSES, listQaVisibleOrders } from '@/lib/qa-order-cleanup.server';

/**
 * GET /api/admin/orders — listado READ-ONLY de pedidos, para diagnóstico.
 *
 * Existe para poder DEMOSTRAR qué pedidos ensucian el kiosco antes de tocar nada:
 * la limpieza (`POST /api/admin/orders/cancel`) exige IDs explícitos, y sin un
 * listado la única forma de obtenerlos sería leer la base a mano.
 *
 * Query:
 *   ?status=confirmed,preparing,ready_for_pickup   (por defecto: los operativos)
 *   ?limit=50                                      (1..200)
 *
 * Salida: `{ ok: true, statuses, orders: AdminOrderView[], generatedAt }`.
 *
 * NUNCA expone: `public_token`, el PIN, `payment_reference`, `idempotency_key` ni la
 * `metadata` cruda (ver lib/admin-order-view.ts: la vista es una lista blanca).
 *
 * 200 con datos · 400 parámetro inválido · 401/503 auth · 503 sin base · 500 fallo.
 */

/** Estados que este listado puede consultar (los que aparecen en el kiosco). */
type OperationalStatus = (typeof QA_CLEANUP_TARGET_STATUSES)[number];

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

  // Lista CERRADA de estados: un valor desconocido se rechaza, no se ignora. Este
  // listado es de operación, no un export libre de la tabla.
  const rawStatuses = request.nextUrl.searchParams.get('status');
  const requested = rawStatuses
    ? [...new Set(rawStatuses.split(',').map((value) => value.trim()).filter(Boolean))]
    : [...QA_CLEANUP_TARGET_STATUSES];

  const unknown = requested.filter(
    (status) => !QA_CLEANUP_TARGET_STATUSES.includes(status as OperationalStatus),
  );
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_status',
        error: `Estados no consultables: ${unknown.join(', ')}.`,
        allowed: [...QA_CLEANUP_TARGET_STATUSES],
      },
      { status: 400 },
    );
  }

  const rawLimit = request.nextUrl.searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return NextResponse.json(
        { ok: false, code: 'invalid_limit', error: 'limit debe ser un entero entre 1 y 200.' },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  try {
    const statuses = requested as OperationalStatus[];
    const orders = await listQaVisibleOrders({ statuses, limit });

    return NextResponse.json(
      { ok: true, statuses, orders, generatedAt: new Date().toISOString() },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin/orders] no se pudo leer el listado', error);
    return NextResponse.json(
      { ok: false, code: 'orders_unavailable', error: 'No se pudo cargar el listado de pedidos.' },
      { status: 500 },
    );
  }
}
