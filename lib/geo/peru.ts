/**
 * lib/geo/peru.ts — reglas puras de ubicación para Perú.
 *
 * Sin base de datos, sin red y sin SDKs: todo lo de acá se puede probar con
 * `node:test`. Lo usan la API, el formulario y los tests.
 */

import type { GeoPoint } from './types';

/**
 * Caja envolvente del Perú continental e insular (incluye islas y el extremo
 * sur de Tacna). Es una comprobación de cordura, no una frontera: sirve para
 * rechazar coordenadas de otro país o ceros accidentales.
 */
export const PERU_BOUNDS = {
  minLatitude: -18.6,
  maxLatitude: 0.1,
  minLongitude: -81.5,
  maxLongitude: -68.6,
} as const;

/** Advertencia (no bloqueo) si el pin queda lejos del centroide del distrito. */
export const PIN_FAR_FROM_DISTRICT_KM = 60;

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidPoint(point: { latitude?: unknown; longitude?: unknown } | null): point is GeoPoint {
  return !!point && isValidLatitude(point.latitude) && isValidLongitude(point.longitude);
}

export function isPointInPeru(point: GeoPoint): boolean {
  return (
    point.latitude >= PERU_BOUNDS.minLatitude &&
    point.latitude <= PERU_BOUNDS.maxLatitude &&
    point.longitude >= PERU_BOUNDS.minLongitude &&
    point.longitude <= PERU_BOUNDS.maxLongitude
  );
}

/** Distancia Haversine en km (misma fórmula que `geo_distance_km` en SQL). */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minúsculas, sin tildes, espacios colapsados. Para comparar nombres. */
export function foldGeoText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-PE')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Limpia una dirección escrita por una persona: quita controles, colapsa
 * espacios y recorta. No inventa ni normaliza abreviaturas.
 */
export function sanitizeAddress(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, maxLength);
}

/** Referencia opcional ("frente al mercado"): más corta y también saneada. */
export function sanitizeReference(value: unknown, maxLength = 120): string | null {
  return sanitizeAddress(value, maxLength);
}

/** Redondeo para usar coordenadas como clave de caché (~1 m). */
export function roundPoint(point: GeoPoint, decimals = 5): string {
  return `${point.latitude.toFixed(decimals)},${point.longitude.toFixed(decimals)}`;
}
