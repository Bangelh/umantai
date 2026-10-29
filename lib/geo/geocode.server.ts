/**
 * lib/geo/geocode.server.ts — punto único de entrada al geocoding.
 *
 * Las rutas y el dominio llaman a estas funciones, nunca al proveedor. Cambiar
 * Geoapify por Mapbox/Google es agregar un adaptador en `providers/` y registrar
 * su nombre acá: ni la base, ni la API de tiendas, ni la UI se enteran.
 *
 * Reglas:
 *   · sin proveedor disponible se devuelve `null` (nunca coordenadas inventadas);
 *   · toda consulta pasa por caché para no gastar cupo ni exponer al proveedor a
 *     ráfagas de clics;
 *   · los logs no incluyen dirección ni coordenadas.
 */

import { logEvent, logSecurityEvent } from '../observability.server';
import { TtlCache } from './cache.server';
import { foldGeoText, roundPoint } from './peru';
import { createGeoapifyGeocoder } from './providers/geoapify';
import type { Geocoder, GeocodeHit, GeocodeQuery, GeoPoint, ReverseHit, UbigeoChain } from './types';
import { resolveUbigeoFromCandidates } from './ubigeo.server';

const HIT_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;

const forwardCache = new TtlCache<{ hit: GeocodeHit | null; expiresIn: number }>({
  max: 500,
  ttlMs: HIT_TTL_MS,
});
const reverseCache = new TtlCache<ReverseHit | null>({ max: 500, ttlMs: HIT_TTL_MS });

let geocoder: Geocoder | null = null;

function createGeocoder(): Geocoder {
  const provider = (process.env.GEO_PROVIDER ?? 'geoapify').trim().toLowerCase();
  if (provider === '' || provider === 'none' || provider === 'disabled') {
    return {
      name: 'disabled',
      available: false,
      forward: async () => null,
      reverse: async () => null,
    };
  }
  return createGeoapifyGeocoder();
}

export function getGeocoder(): Geocoder {
  if (!geocoder) geocoder = createGeocoder();
  return geocoder;
}

export function isGeocoderAvailable(): boolean {
  return getGeocoder().available;
}

/** Solo para tests: olvida instancia y cachés. */
export function resetGeocoderForTests(): void {
  geocoder = null;
  forwardCache.clear();
  reverseCache.clear();
}

function forwardKey(query: GeocodeQuery): string {
  const district = query.ubigeo?.code ?? '-';
  return `${getGeocoder().name}|${district}|${foldGeoText(query.address)}`;
}

/**
 * Traduce los nombres del proveedor al catálogo UBIGEO y ajusta la confianza.
 *
 * `high` exige dos cosas: que el proveedor haya identificado una vía con rank
 * suficiente y que el resultado caiga en el distrito pedido. Si el catálogo no
 * puede resolver la cadena administrativa, la coincidencia baja a `low` en vez
 * de darse por buena.
 */
async function canonicalizeHit(
  hit: GeocodeHit,
  requested: UbigeoChain | null | undefined,
): Promise<GeocodeHit> {
  let resolved: UbigeoChain | null = null;
  try {
    resolved = await resolveUbigeoFromCandidates({
      department: hit.department,
      province: hit.province,
      names: hit.districtCandidates,
    });
  } catch (error) {
    logSecurityEvent('geocode_ubigeo_match_failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return { ...hit, confidence: 'low' };
  }

  if (!resolved) return { ...hit, confidence: 'low' };

  const sameDistrict = !requested || resolved.code === requested.code;
  return {
    ...hit,
    department: resolved.department,
    province: resolved.province,
    district: resolved.district,
    confidence: hit.confidence === 'high' && sameDistrict ? 'high' : 'low',
  };
}

/**
 * Dirección → punto.
 *
 * Devuelve `null` cuando no hay proveedor o no hay coincidencia. Los errores del
 * proveedor también se traducen a `null`: el comerciante puede ubicar el pin a
 * mano y no se le bloquea el guardado.
 */
export async function forwardAddress(query: GeocodeQuery): Promise<{
  hit: GeocodeHit | null;
  cached: boolean;
  provider: string;
}> {
  const provider = getGeocoder().name;
  const key = forwardKey(query);
  const cached = forwardCache.get(key);
  if (cached) return { hit: cached.hit, cached: true, provider };

  const started = Date.now();
  let hit: GeocodeHit | null = null;
  try {
    hit = await getGeocoder().forward(query);
  } catch (error) {
    logSecurityEvent('geocode_forward_failed', {
      provider,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    // Un fallo del proveedor no se cachea: el usuario puede reintentar.
    return { hit: null, cached: false, provider };
  }

  if (hit) hit = await canonicalizeHit(hit, query.ubigeo);

  forwardCache.set(key, { hit, expiresIn: hit ? HIT_TTL_MS : MISS_TTL_MS });
  logEvent('geocode_forward', {
    provider,
    matched: hit !== null,
    confidence: hit?.confidence ?? 'none',
    durationMs: Date.now() - started,
  });

  return { hit, cached: false, provider };
}

/** Punto → dirección. Misma política: sin proveedor o sin match → `null`. */
export async function reversePoint(point: GeoPoint): Promise<{
  hit: ReverseHit | null;
  cached: boolean;
  provider: string;
}> {
  const provider = getGeocoder().name;
  const key = `${provider}|${roundPoint(point)}`;
  if (reverseCache.size > 0) {
    const cached = reverseCache.get(key);
    if (cached !== undefined) return { hit: cached, cached: true, provider };
  }

  const started = Date.now();
  let hit: ReverseHit | null = null;
  try {
    hit = await getGeocoder().reverse(point);
  } catch (error) {
    logSecurityEvent('geocode_reverse_failed', {
      provider,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return { hit: null, cached: false, provider };
  }

  reverseCache.set(key, hit);
  logEvent('geocode_reverse', {
    provider,
    matched: hit !== null,
    durationMs: Date.now() - started,
  });

  return { hit, cached: false, provider };
}
