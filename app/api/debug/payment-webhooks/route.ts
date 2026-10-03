import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { isCommerceDbConfigured, listPaymentWebhookEvents } from '@/lib/commerce.server';

/**
 * GET /api/debug/payment-webhooks — últimos webhooks de Mercado Pago recibidos.
 *
 * Solo ADMIN (header `x-admin-token`), NUNCA público. Es la superficie de lectura
 * de la tabla `payment_webhook_events` (migración 004), pensada para comparar una
 * notificación AUTOMÁTICA (que devuelve 401) contra una SIMULADA (que devuelve 200)
 * sin depender de los logs de Vercel.
 *
 * Devuelve SOLO metadatos no sensibles: presencia y longitud de los headers de firma,
 * tipos/ids y `signatureOk`. Nunca el valor de `x-signature`, `v1`, el `x-request-id`
 * completo ni ningún secreto.
 *
 * Query params:
 *   · `limit`  (opcional) 1–200, por defecto 50.
 *   · `dataId` (opcional) filtra por Payment ID (`data.id`).
 *
 * 200 · 400 `limit` inválido · 401/503 auth · 503 sin base o migración sin aplicar
 * · 500 fallo.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Postgres: `undefined_table` cuando la migración 004 aún no se aplicó. */
function isUndefinedTable(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === '42P01') return true;
  const message = (error as { message?: string } | null | undefined)?.message ?? '';
  return message.includes('payment_webhook_events') && message.includes('does not exist');
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

  const rawLimit = request.nextUrl.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json(
        {
          ok: false,
          code: 'invalid_limit',
          error: `limit debe ser un entero entre 1 y ${MAX_LIMIT}.`,
        },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  const dataId = request.nextUrl.searchParams.get('dataId');

  try {
    const events = await listPaymentWebhookEvents({ limit, dataId });
    return NextResponse.json(
      {
        ok: true,
        count: events.length,
        limit,
        dataId: dataId?.trim() || null,
        events,
        generatedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    // La causa más probable en Preview es que la migración 004 todavía no se aplicó.
    if (isUndefinedTable(error)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'webhook_events_table_missing',
          error:
            'La tabla payment_webhook_events no existe todavía: aplica la migración 004.',
        },
        { status: 503 },
      );
    }
    console.error('[debug/payment-webhooks] no se pudieron leer los eventos', error);
    return NextResponse.json(
      { ok: false, code: 'webhook_events_unavailable', error: 'No se pudieron cargar los eventos.' },
      { status: 500 },
    );
  }
}
