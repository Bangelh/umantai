/**
 * POST /api/geo/geocode — dirección + distrito → punto en el mapa.
 *
 * Solo para comerciantes con sesión (es una ayuda del onboarding, no un servicio
 * público). El proveedor y su key viven en el servidor.
 *
 *   { address: "Av. Grau 123", ubigeo: "200706" }
 *   → { ok: true, hit: { point, formatted, confidence, … } | null }
 *
 * · `hit: null` = el proveedor no reconoció la dirección. NO es un error: la UI
 *   pide mover el marcador a mano.
 * · 503 `geocoder_unavailable` = no hay proveedor configurado (sin key).
 * · Rate limit por usuario: 20 búsquedas por minuto.
 */

import { NextResponse } from 'next/server';

import { getSessionUser } from '@/lib/auth.server';
import { isGeocoderAvailable, forwardAddress } from '@/lib/geo/geocode.server';
import { getUbigeoChain } from '@/lib/geo/ubigeo.server';
import { logSecurityEvent } from '@/lib/observability.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

interface Body {
  address?: unknown;
  ubigeo?: unknown;
}

export async function POST(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { ok: false, code: 'not_authenticated', error: 'Necesitas iniciar sesión.' },
      { status: 401, headers: NO_STORE },
    );
  }

  const limited = await rateLimitGate(request, 'geo-geocode', {
    limit: 20,
    windowMs: 60_000,
    key: `geo-geocode:${user.id}`,
  });
  if (limited) return limited;

  // La forma del payload se valida primero: un 400 no debe depender de si hay
  // proveedor configurado.
  const body = await readJsonBody<Body>(request);
  const address = typeof body?.address === 'string' ? body.address.trim() : '';
  const ubigeo = typeof body?.ubigeo === 'string' ? body.ubigeo.trim() : '';

  if (address.length < 3 || address.length > 160) {
    return NextResponse.json(
      { ok: false, code: 'invalid_address', error: 'Escribe una dirección válida.' },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!/^[0-9]{6}$/.test(ubigeo)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_ubigeo', error: 'Elige el distrito primero.' },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!isGeocoderAvailable()) {
    return NextResponse.json(
      {
        ok: false,
        code: 'geocoder_unavailable',
        error: 'La búsqueda de direcciones no está disponible ahora mismo.',
      },
      { status: 503, headers: NO_STORE },
    );
  }

  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'db_not_configured' },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const chain = await getUbigeoChain(ubigeo);
    if (!chain) {
      return NextResponse.json(
        { ok: false, code: 'ubigeo_not_found', error: 'El distrito no existe.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const { hit, cached, provider } = await forwardAddress({ address, ubigeo: chain });

    return NextResponse.json(
      {
        ok: true,
        provider,
        cached,
        // Sin coincidencia no se inventa nada: el pin manual manda.
        hit: hit
          ? {
              point: hit.point,
              formatted: hit.formatted,
              confidence: hit.confidence,
              district: hit.district,
              province: hit.province,
              department: hit.department,
            }
          : null,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    logSecurityEvent('geocode_route_failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return platformErrorResponse(error);
  }
}
