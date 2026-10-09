import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import {
  isCommerceDbConfigured,
  listOrdersWithActiveReservations,
} from '@/lib/commerce.server';
import { QA_CLEANUP_TARGET_STATUSES, listQaVisibleOrders } from '@/lib/qa-order-cleanup.server';

/**
 * GET /api/admin/orders — listado READ-ONLY de pedidos, para diagnóstico.
 *
 * Existe para poder DEMOSTRAR qué pedidos ensucian el kiosco antes de tocar nada:
 * la limpieza (`POST /api/admin/orders/cancel`) exige IDs explícitos, y sin un
 * listado la única forma de obtenerlos sería leer la base a mano.
 *
 * ─── DOS MODOS (ambos de SOLO LECTURA) ──────────────────────────────────────
 *   · Listado operativo (por defecto)
 *       ?status=confirmed,preparing,ready_for_pickup   (por defecto: los operativos)
 *       Los pedidos que aparecen (o pueden aparecer) en la cola del kiosco.
 *
 *   · Auditoría de reservas vivas
 *       ?reservationActive=1
 *       ?product=dyson-v15-detect                      (opcional: filtra por SKU)
 *       Pedidos que RETIENEN stock AHORA, según el LEDGER (`inventory_movements`),
 *       en CUALQUIER estado. Es la única forma de ver una reserva huérfana que el
 *       kiosco no muestra (p. ej. un `pending_payment` que nunca se pagó). Incluye,
 *       por línea retenida, los movimientos de inventario que la explican.
 *
 * Reglas comunes: `?limit=50` (1..200). En `?reservationActive=1` NO se acepta `status`
 * (el estado no es la autoridad de una reserva viva) y el valor debe ser exactamente `1`.
 *
 * Salida: `{ ok: true, reservationActive, orders: AdminOrderView[], generatedAt }`.
 *
 * NUNCA expone: `public_token`, el PIN, `payment_reference`, `idempotency_key` ni la
 * `metadata` cruda (ver lib/admin-order-view.ts: la vista es una lista blanca).
 *
 * 200 con datos · 400 parámetro inválido · 401/503 auth · 503 sin base · 500 fallo.
 */

/** Estados que el listado operativo puede consultar (los que aparecen en el kiosco). */
type OperationalStatus = (typeof QA_CLEANUP_TARGET_STATUSES)[number];

/** Valida y normaliza `?limit`. Devuelve `undefined` si no vino. */
function parseLimit(raw: string | null): { ok: true; limit: number | undefined } | { ok: false } {
  if (raw === null) return { ok: true, limit: undefined };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return { ok: false };
  return { ok: true, limit: parsed };
}

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

  const limitResult = parseLimit(request.nextUrl.searchParams.get('limit'));
  if (!limitResult.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_limit', error: 'limit debe ser un entero entre 1 y 200.' },
      { status: 400 },
    );
  }
  const limit = limitResult.limit;

  // Lista CERRADA: sólo `1` enciende la auditoría de reservas. Cualquier otro valor
  // (incluido `0`) se rechaza, para que el filtro nunca se active por accidente.
  const rawReservationActive = request.nextUrl.searchParams.get('reservationActive');
  if (rawReservationActive !== null && rawReservationActive !== '1') {
    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_reservation_active',
        error: 'reservationActive sólo acepta el valor "1".',
      },
      { status: 400 },
    );
  }

  try {
    // ── Auditoría de reservas vivas: la autoridad es el ledger, no el estado. ──
    if (rawReservationActive === '1') {
      const rawStatus = request.nextUrl.searchParams.get('status');
      if (rawStatus !== null) {
        return NextResponse.json(
          {
            ok: false,
            code: 'invalid_filter',
            error: 'reservationActive=1 no acepta `status`: la reserva viva se decide por el ledger.',
          },
          { status: 400 },
        );
      }

      const rawProduct = request.nextUrl.searchParams.get('product');
      const productSlug = rawProduct && rawProduct.trim() ? rawProduct.trim() : undefined;

      const orders = await listOrdersWithActiveReservations({ productSlug, limit });

      return NextResponse.json(
        {
          ok: true,
          reservationActive: true,
          product: productSlug ?? null,
          orders,
          generatedAt: new Date().toISOString(),
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // ── Listado operativo: lista CERRADA de estados (un valor desconocido se rechaza). ──
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

    const statuses = requested as OperationalStatus[];
    const orders = await listQaVisibleOrders({ statuses, limit });

    return NextResponse.json(
      {
        ok: true,
        reservationActive: false,
        product: null,
        statuses,
        orders,
        generatedAt: new Date().toISOString(),
      },
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
