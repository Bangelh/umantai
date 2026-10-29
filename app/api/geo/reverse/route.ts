/**
 * POST /api/geo/reverse — punto (GPS o pin) → dirección + UBIGEO sugerido.
 *
 *   { latitude: -4.1069, longitude: -81.0539 }
 *   → { ok: true, address: "…", ubigeo: { code, district, province, department } | null }
 *
 * El UBIGEO sugerido SOLO se devuelve cuando departamento + provincia + distrito
 * coinciden de forma inequívoca con el catálogo. Ante cualquier duda devuelve
 * `null`: la UI mantiene los selects como estaban en vez de imponer una
 * coincidencia dudosa.
 *
 * No se registran coordenadas ni direcciones en logs.
 */

import { NextResponse } from 'next/server';

import { getSessionUser } from '@/lib/auth.server';
import { isGeocoderAvailable, reversePoint } from '@/lib/geo/geocode.server';
import { isValidPoint, isPointInPeru } from '@/lib/geo/peru';
import { matchUbigeoByName } from '@/lib/geo/ubigeo.server';
import { logSecurityEvent } from '@/lib/observability.server';
import { platformErrorResponse, readJsonBody } from '@/lib/platform-api.server';
import { isPlatformDbConfigured } from '@/lib/platform-db.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

interface Body {
  latitude?: unknown;
  longitude?: unknown;
}

export async function POST(request: Request) {
  const user = await getSessionUser(request.headers);
  if (!user) {
    return NextResponse.json(
      { ok: false, code: 'not_authenticated', error: 'Necesitas iniciar sesión.' },
      { status: 401, headers: NO_STORE },
    );
  }

  const limited = await rateLimitGate(request, 'geo-reverse', {
    limit: 20,
    windowMs: 60_000,
    key: `geo-reverse:${user.id}`,
  });
  if (limited) return limited;

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

  const body = await readJsonBody<Body>(request);
  const point = {
    latitude: typeof body?.latitude === 'number' ? body.latitude : Number(body?.latitude),
    longitude: typeof body?.longitude === 'number' ? body.longitude : Number(body?.longitude),
  };

  if (!isValidPoint(point) || !isPointInPeru(point)) {
    return NextResponse.json(
      { ok: false, code: 'invalid_point', error: 'La ubicación debe estar dentro del Perú.' },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!isPlatformDbConfigured()) {
    return NextResponse.json(
      { ok: false, code: 'db_not_configured' },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const { hit, provider } = await reversePoint(point);
    if (!hit) {
      return NextResponse.json({ ok: true, provider, address: null, ubigeo: null }, { headers: NO_STORE });
    }

    const ubigeo = await matchUbigeoByName({
      department: hit.department,
      province: hit.province,
      district: hit.district,
    }).catch((error: unknown) => {
      logSecurityEvent('geocode_ubigeo_match_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    });

    return NextResponse.json(
      {
        ok: true,
        provider,
        address: hit.addressLine ?? hit.formatted,
        ubigeo,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return platformErrorResponse(error);
  }
}
