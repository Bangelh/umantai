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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ CUENTA COMO COINCIDENCIA (por qué no todo vale)
 *
 *  Geoapify SIEMPRE devuelve algo cuando se le pasa un distrito: si no reconoce
 *  la calle, responde el centro del distrito con
 *  `rank.match_type = "match_by_city_or_disrict"`. Aceptar eso como dirección
 *  convertía "zzzz qqq 0000" en un pin válido con confianza alta.
 *
 *  Por eso se mira `rank.match_type` y `rank.confidence`:
 *
 *    · `administrative` (ciudad/distrito/postcode/estado/país) → NO es una
 *      dirección: el adaptador devuelve `null` y la UI ofrece el pin manual.
 *    · `exact` (full_match / inner_part / match_by_building) → sirve, pero solo
 *      es `high` si además el rank ≥ 0.5 y el distrito coincide.
 *    · `approximate` (match_by_street: calle sin número) → `low`.
 *    · `unknown` (sin match_type) → `low` si hay calle; si no, `null`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  MAPEO TERRITORIAL EN PERÚ
 *
 *  Los nombres de Geoapify NO son los del UBIGEO. En Perú:
 *
 *    · `properties.district` es el BARRIO/urbanización ("Barrio Nicaragua");
 *    · `properties.city`     es el DISTRITO administrativo ("Máncora");
 *    · `properties.county`   es la PROVINCIA ("Talara");
 *    · `properties.state`    es el DEPARTAMENTO ("Piura").
 *
 *  En Lima, en cambio, `district` sí trae el distrito ("Miraflores") y `city`
 *  trae "Lima". Por eso el adaptador no elige uno: devuelve
 *  `districtCandidates` del más específico al más general y el servidor resuelve
 *  contra el catálogo UBIGEO (`resolveUbigeoFromCandidates`), aceptando solo una
 *  coincidencia inequívoca.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getPrefixedEnv } from '../../env';
import { foldGeoText } from '../peru';
import type {
  Geocoder,
  GeocodeHit,
  GeocodePrecision,
  GeocodeQuery,
  GeoPoint,
  ReverseHit,
} from '../types';

const ENDPOINT = 'https://api.geoapify.com/v1/geocode';
const TIMEOUT_MS = 8_000;
/** Rank mínimo para dar una dirección por buena (`high`). */
const HIGH_CONFIDENCE_RANK = 0.5;

/** Tipos que solo identifican una unidad administrativa, no una calle. */
const ADMINISTRATIVE_MATCH_TYPES = new Set([
  'match_by_city_or_disrict', // sic: valor real que devuelve la API
  'match_by_city_or_district',
  'match_by_postcode',
  'match_by_county',
  'match_by_state',
  'match_by_country',
]);

/** Tipos que identifican una calle y, cuando aplica, un número de puerta. */
const EXACT_MATCH_TYPES = new Set(['full_match', 'inner_part', 'match_by_building']);

interface GeoapifyProperties {
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  district?: string;
  suburb?: string;
  city?: string;
  county?: string;
  state?: string;
  country_code?: string;
  postcode?: string;
  lat?: number;
  lon?: number;
  rank?: { confidence?: number; match_type?: string };
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

/**
 * Precisión declarada por el proveedor.
 *
 * Un `match_type` ausente no se interpreta como "exacto": queda `unknown` y,
 * como mucho, produce una coincidencia `low`.
 */
export function precisionOf(matchType: string | undefined): GeocodePrecision {
  if (!matchType) return 'unknown';
  if (ADMINISTRATIVE_MATCH_TYPES.has(matchType)) return 'administrative';
  if (EXACT_MATCH_TYPES.has(matchType)) return 'exact';
  if (matchType === 'match_by_street') return 'approximate';
  return 'unknown';
}

function rankConfidence(properties: GeoapifyProperties): number | null {
  const value = properties.rank?.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Nombres de distrito candidatos, del más específico al más general. */
function districtCandidates(properties: GeoapifyProperties): string[] {
  const names = [properties.district, properties.suburb, properties.city]
    .map((value) => value?.trim() ?? '')
    .filter((value) => value.length > 0);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = foldGeoText(name);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

/**
 * Un resultado solo sirve como dirección si identifica una vía.
 *
 * · coincidencia administrativa (solo ciudad/distrito) → `null`;
 * · sin `address_line1` → `null` (no hay calle que mostrar);
 * · `address_line1` igual al distrito/ciudad → `null` (Geoapify repite el
 *   nombre del lugar cuando no encontró la vía).
 */
function streetLine(properties: GeoapifyProperties): string | null {
  const line = properties.address_line1?.trim() ?? '';
  if (line.length < 3) return null;

  const folded = foldGeoText(line);
  const placeNames = [properties.district, properties.city, properties.suburb]
    .map((value) => (value ? foldGeoText(value) : ''))
    .filter((value) => value.length > 0);
  if (placeNames.includes(folded)) return null;

  return line;
}

function toHit(
  feature: GeoapifyFeature,
): { hit: GeocodeHit; streetLine: string | null } | null {
  const properties = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates;
  const latitude = typeof properties.lat === 'number' ? properties.lat : coordinates?.[1];
  const longitude = typeof properties.lon === 'number' ? properties.lon : coordinates?.[0];
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const precision = precisionOf(properties.rank?.match_type);
  const candidates = districtCandidates(properties);

  return {
    streetLine: streetLine(properties),
    hit: {
      point: { latitude, longitude },
      formatted: properties.formatted?.trim() || properties.address_line1?.trim() || '',
      // El servidor puede bajarla, nunca subirla. `high` exige rank alto.
      confidence:
        precision === 'exact' && (rankConfidence(properties) ?? 0) >= HIGH_CONFIDENCE_RANK
          ? 'high'
          : 'low',
      department: properties.state?.trim() || null,
      // En Perú la provincia llega como `county`.
      province: properties.county?.trim() || null,
      district: candidates[0] ?? null,
      districtCandidates: candidates,
      precision,
    },
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

      const mapped = toHit(feature);
      if (!mapped) return null;

      const { hit, streetLine: line } = mapped;
      // Sin calle no hay dirección: el centro del distrito no es una coincidencia.
      if (hit.precision === 'administrative') return null;
      if (!line) return null;

      // Solo es `high` si además el proveedor devolvió el MISMO distrito pedido.
      // (El servidor vuelve a comprobarlo contra el catálogo UBIGEO.)
      const expected = query.ubigeo?.district ? foldGeoText(query.ubigeo.district) : null;
      const sameDistrict =
        !expected || hit.districtCandidates.some((name) => foldGeoText(name) === expected);
      if (!sameDistrict) hit.confidence = 'low';

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

      const mapped = toHit(feature);
      if (!mapped) return null;

      const properties = feature.properties ?? {};
      const addressLine =
        [properties.address_line1, properties.address_line2]
          .map((part) => part?.trim())
          .filter((part): part is string => !!part && part.length > 0)
          .join(', ') || null;

      return {
        ...mapped.hit,
        // El reverse siempre describe un punto: no se descarta por precisión,
        // pero tampoco se da por exacto si el proveedor no dio una vía.
        confidence:
          mapped.hit.precision === 'exact' && mapped.hit.confidence === 'high' ? 'high' : 'low',
        addressLine,
        ubigeoHint: null, // lo resuelve el servidor contra el catálogo
      };
    },
  };
}
