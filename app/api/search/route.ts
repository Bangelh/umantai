/**
 * GET /api/search — buscador global de productos y tiendas.
 *
 *   ?q=arroz&lat=-12.0464&lng=-77.0428&radius=5&limit=20&offset=0
 *
 * Reglas:
 *   · `q` opcional (vacío = explorar lo cercano).
 *   · `lat`/`lng` juntos o ausentes. Sin ubicación la búsqueda es global: la app
 *     nunca se bloquea por falta de GPS.
 *   · `radius` 1–50 km (default 5).
 *   · `limit` 1–50, `offset` 0–1000.
 *
 * Respuesta: products[], stores[], metadata.
 * Rendimiento: 1 consulta para productos (con total por window function) + 1
 * para tiendas. Nada de N+1 por producto.
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseDiscoveryQuery } from '@/lib/discovery';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { searchDiscovery } from '@/lib/stores.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { withRequestLogging } from '@/lib/observability.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleSearch(request: NextRequest) {
  // Búsqueda pública: 150/min por IP. El debounce del cliente ya evita ráfagas
  // normales; esto corta scrapers y bucles.
  const gate = await rateLimitGate(request, 'search', { limit: 150, windowMs: 60_000 });
  if (gate) return gate;

  const parsed = parseDiscoveryQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.message, code: parsed.code },
      { status: parsed.status },
    );
  }

  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { error: 'Base de datos no configurada.', code: 'db_not_configured' },
      { status: 503 },
    );
  }

  try {
    const { products, stores, total } = await searchDiscovery(parsed.query);

    return NextResponse.json(
      {
        products,
        stores,
        metadata: {
          q: parsed.query.q,
          location: parsed.query.location,
          radiusKm: parsed.query.radiusKm,
          limit: parsed.query.limit,
          offset: parsed.query.offset,
          total,
          hasMore: parsed.query.offset + products.length < total,
          generatedAt: new Date().toISOString(),
        },
      },
      {
        headers: {
          // Resultados públicos: se tolera un caché muy corto (la disponibilidad
          // cambia con el inventario). El navegador no cachea.
          'cache-control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=30',
        },
      },
    );
  } catch (error) {
    console.error('[search] error', error);
    return NextResponse.json(
      { error: 'No se pudo ejecutar la búsqueda.', code: 'search_failed' },
      { status: 500 },
    );
  }
}

export const GET = withRequestLogging('/api/search', handleSearch as never);
