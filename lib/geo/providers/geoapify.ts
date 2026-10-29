/**
 * lib/geo/providers/geoapify.ts — adaptador Geoapify (geocoding + reverse).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLAS
 *
 *  · La API key vive SOLO en el servidor (`GEOAPIFY_API_KEY`). Este módulo se
 *    importa únicamente desde rutas de servidor; el navegador nunca la ve.
 *  · Toda búsqueda se acota a Perú (`filter=countrycode:pe`) y se sesga al
 *    centroide del distrito elegido, para que "Av. Grau 123" no salte de ciudad.
 *  · Sin key, el adaptador queda `available = false`: el formulario sigue
 *    funcionando con el pin manual y la API responde 503. Nunca se inventan
 *    coordenadas.
 *  · No se loguea la dirección ni el punto: son datos del comerciante.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getPrefixedEnv } from '../../env';
import { foldGeoText } from '../peru';
import type { Geocoder, GeocodeHit, GeocodeQuery, GeoPoint, ReverseHit } from '../types';

const ENDPOINT = 'https://api.geoapify.com/v1/geocode';
const TIMEOUT_MS = 8_000;

interface GeoapifyProperties {
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  country_code?: string;
  lat?: number;
  lon?: number;
  rank?: { confidence?: number };
}

interface GeoapifyFeature {
  properties?: GeoapifyProperties;
  geometry?: { coordinates?: [number, number] };
}

interface GeoapifyResponse {
  features?: GeoapifyFeature[];
}

function apiKey(): string {
  return (getPrefixedEnv('GEOAPIFY_API_KEY') ?? '').trim();
}

function toHit(feature: GeoapifyFeature): GeocodeHit | null {
  const properties = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates;
  const latitude = typeof properties.lat === 'number' ? properties.lat : coordinates?.[1];
  const longitude = typeof properties.lon === 'number' ? properties.lon : coordinates?.[0];
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    point: { latitude, longitude },
    formatted: properties.formatted?.trim() || properties.address_line1?.trim() || '',
    confidence: 'low',
    department: properties.state?.trim() || null,
    // En Geoapify la provincia peruana llega como `county`.
    province: properties.county?.trim() || null,
    district: properties.district?.trim() || properties.city?.trim() || null,
  };
}

async function request(url: URL): Promise<GeoapifyResponse | null> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) {
    // 401/403 = key inválida o sin permiso; 429 = cupo. El llamador decide.
    throw new Error(`geoapify_http_${response.status}`);
  }
  return (await response.json()) as GeoapifyResponse;
}

export function createGeoapifyGeocoder(): Geocoder {
  const key = apiKey();
  const available = key.length > 0;

  return {
    name: 'geoapify',
    available,

    async forward(query: GeocodeQuery): Promise<GeocodeHit | null> {
      if (!available) return null;

      const parts = [query.address];
      if (query.ubigeo) {
        parts.push(query.ubigeo.district, query.ubigeo.province, query.ubigeo.department);
      }
      parts.push('Perú');

      const url = new URL(`${ENDPOINT}/search`);
      url.searchParams.set('text', parts.join(', '));
      url.searchParams.set('filter', 'countrycode:pe');
      url.searchParams.set('lang', 'es');
      url.searchParams.set('limit', '1');
      url.searchParams.set('format', 'geojson');
      if (query.ubigeo?.centroid) {
        url.searchParams.set(
          'bias',
          `proximity:${query.ubigeo.centroid.longitude},${query.ubigeo.centroid.latitude}`,
        );
      }
      url.searchParams.set('apiKey', key);

      const payload = await request(url);
      const feature = payload?.features?.[0];
      if (!feature) return null;

      const hit = toHit(feature);
      if (!hit) return null;

      // Solo es "alta" si el proveedor devuelve el MISMO distrito elegido.
      const expected = query.ubigeo?.district ? foldGeoText(query.ubigeo.district) : null;
      const got = hit.district ? foldGeoText(hit.district) : null;
      if (expected && got && expected === got) hit.confidence = 'high';

      return hit;
    },

    async reverse(point: GeoPoint): Promise<ReverseHit | null> {
      if (!available) return null;

      const url = new URL(`${ENDPOINT}/reverse`);
      url.searchParams.set('lat', String(point.latitude));
      url.searchParams.set('lon', String(point.longitude));
      url.searchParams.set('lang', 'es');
      url.searchParams.set('limit', '1');
      url.searchParams.set('format', 'geojson');
      url.searchParams.set('apiKey', key);

      const payload = await request(url);
      const feature = payload?.features?.[0];
      if (!feature) return null;

      const hit = toHit(feature);
      if (!hit) return null;

      const properties = feature.properties ?? {};
      const addressLine =
        [properties.address_line1, properties.address_line2]
          .map((part) => part?.trim())
          .filter((part): part is string => !!part && part.length > 0)
          .join(', ') || null;

      return {
        ...hit,
        confidence: 'high',
        addressLine,
        ubigeoHint: null, // lo resuelve el servidor contra el catálogo
      };
    },
  };
}
