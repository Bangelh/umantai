import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin.server';
import { getAnalyticsSummary, isAnalyticsDbConfigured } from '@/lib/analytics.server';
import { resolveAnalyticsRange } from '@/lib/analytics';

/**
 * GET /api/admin/analytics/summary — KPIs, series, estados y stock del panel.
 *
 * Query:
 *   range   today | 7d | 30d | custom           (default 30d)
 *   from,to YYYY-MM-DD (obligatorios con range=custom; día comercial de Lima)
 *   location  código de local, default MAIN     (futuro scope de tienda)
 *
 * Respuestas:
 *   200 { ok: true, ...summary }
 *   400 { ok: false, code: 'invalid_range' | 'invalid_query' }
 *   401/503 auth admin (mismo contrato que el resto de /api/admin/*)
 *   503 base no configurada
 *   500 { ok: false, code: 'analytics_unavailable' } (sin detalles internos)
 *
 * Solo lectura: no crea, modifica ni exporta datos personales.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const access = await requireAdminAccess(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, code: access.code, error: access.message },
      { status: access.status },
    );
  }

  if (!isAnalyticsDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'database_not_configured', error: 'La base de datos no está configurada.' },
      { status: 503 },
    );
  }

  const params = request.nextUrl.searchParams;
  const range = resolveAnalyticsRange({
    preset: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
  });

  if (!range.ok) {
    return NextResponse.json(
      { ok: false, code: 'invalid_range', error: range.error },
      { status: 400 },
    );
  }

  const location = (params.get('location') ?? 'MAIN').trim() || 'MAIN';
  if (!/^[A-Z0-9_-]{1,32}$/.test(location)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_query', error: 'location no es válido.' },
      { status: 400 },
    );
  }

  try {
    const summary = await getAnalyticsSummary({
      range: range.range,
      previous: range.previous,
      locationCode: location,
    });

    return NextResponse.json(
      { ok: true, ...summary },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // El log interno puede tener detalle; la respuesta no (no filtra SQL ni datos).
    console.error('[admin/analytics] no se pudo calcular el resumen', error);
    return NextResponse.json(
      {
        ok: false,
        code: 'analytics_unavailable',
        error: 'No se pudo calcular el resumen de ventas. Reintenta en unos segundos.',
      },
      { status: 500 },
    );
  }
}
