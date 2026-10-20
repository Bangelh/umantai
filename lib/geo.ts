/**
 * lib/geo.ts — geolocalización sin PostGIS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DECISIÓN
 *
 *  Para esta fase alcanza con:
 *    1. un bounding box indexable (`latitude`/`longitude` btree) para descartar
 *       la enorme mayoría de tiendas con un rango,
 *    2. Haversine exacto sobre los sobrevivientes.
 *
 *  PostGIS agrega una dependencia de infraestructura (extensión, tipos,
 *  índices GiST) que todavía no se justifica: hay pocas tiendas por ciudad y la
 *  consulta ya usa el índice. Si en el futuro hay millones de filas o se
 *  necesitan polígonos/rutas, se migra a `geography(Point)`.
 *
 *  Precisión: Haversine sobre esfera de radio medio 6371.0088 km. Error < 0.5 %
 *  frente a WGS84, más que suficiente para un radio de 1–20 km.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { formatDistance } from './format';

export const EARTH_RADIUS_KM = 6371.0088;

/** Opciones que ofrece la UI (la API acepta cualquier valor 1–50). */
export const RADIUS_OPTIONS_KM = [1, 2, 5, 10, 20] as const;
export const DEFAULT_RADIUS_KM = 5;
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 50;
export const MAX_RESULTS = 50;
export const DEFAULT_PAGE_SIZE = 20;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export type RadiusKm = (typeof RADIUS_OPTIONS_KM)[number];

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidPoint(point: { latitude?: unknown; longitude?: unknown } | null | undefined): point is GeoPoint {
  return !!point && isValidLatitude(point.latitude) && isValidLongitude(point.longitude);
}

/** Radianes. */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Distancia Haversine en kilómetros entre dos puntos.
 * Simétrica y con resultado 0 para el mismo punto.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Caja que contiene el círculo de `radiusKm`. Se usa SOLO como pre-filtro: la
 * pertenencia real al radio se decide con Haversine.
 *
 * En latitudes altas la caja se ensancha en longitud; si cruza el antimeridiano
 * se devuelve el rango completo (-180..180), que es correcto aunque menos
 * selectivo. En los polos también se abre el rango completo.
 */
export function boundingBox(center: GeoPoint, radiusKm: number): BoundingBox {
  const safeRadius = clampRadius(radiusKm);
  const latDelta = safeRadius / 111.32;
  const cosLat = Math.cos(toRadians(center.latitude));

  const minLat = Math.max(-90, center.latitude - latDelta);
  const maxLat = Math.min(90, center.latitude + latDelta);

  if (Math.abs(cosLat) < 1e-6) {
    return { minLat, maxLat, minLng: -180, maxLng: 180 };
  }

  const lngDelta = safeRadius / (111.32 * Math.abs(cosLat));
  if (lngDelta >= 180) {
    return { minLat, maxLat, minLng: -180, maxLng: 180 };
  }

  let minLng = center.longitude - lngDelta;
  let maxLng = center.longitude + lngDelta;

  // Cruce del antimeridiano: no se puede expresar como un rango btree simple.
  if (minLng < -180 || maxLng > 180) {
    return { minLat, maxLat, minLng: -180, maxLng: 180 };
  }

  minLng = Math.max(-180, minLng);
  maxLng = Math.min(180, maxLng);
  return { minLat, maxLat, minLng, maxLng };
}

export function clampRadius(radiusKm: number): number {
  if (!Number.isFinite(radiusKm)) return DEFAULT_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, radiusKm));
}

/** Normaliza el radio pedido por el usuario. Devuelve null si es inválido. */
export function parseRadius(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_RADIUS_KM;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < MIN_RADIUS_KM || value > MAX_RADIUS_KM) return null;
  return Math.round(value * 10) / 10;
}

/**
 * Texto compacto para listas: "400 m", "3,2 km", "12 km".
 * Delega en `lib/format.ts` para que el separador decimal siga el locale.
 */
export function formatDistanceKm(
  distanceKm: number | null | undefined,
  locale: 'es' | 'en' = 'es',
): string {
  return formatDistance(distanceKm, locale);
}
