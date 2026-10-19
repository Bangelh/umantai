/**
 * lib/locations.ts — ubicaciones manuales para cuando no hay GPS.
 *
 * La geolocalización del navegador es OPCIONAL. Si el usuario la rechaza (o el
 * dispositivo no la soporta), la home no se bloquea: elige una zona de esta
 * lista o escribe coordenadas.
 *
 * Estos presets son del piloto (Lima). No son datos legales ni una base
 * geoespacial: son puntos de referencia para el fallback. Si UMANTAI opera en
 * otra ciudad, se agregan acá.
 */

import type { GeoPoint } from './geo';

export interface LocationPreset extends GeoPoint {
  id: string;
  label: string;
  region: string;
}

export const LOCATION_PRESETS: readonly LocationPreset[] = [
  { id: 'lima-centro', label: 'Lima Centro', region: 'Lima', latitude: -12.0464, longitude: -77.0428 },
  { id: 'miraflores', label: 'Miraflores', region: 'Lima', latitude: -12.1219, longitude: -77.0297 },
  { id: 'san-isidro', label: 'San Isidro', region: 'Lima', latitude: -12.0972, longitude: -77.0365 },
  { id: 'surco', label: 'Santiago de Surco', region: 'Lima', latitude: -12.145, longitude: -77.005 },
  { id: 'la-molina', label: 'La Molina', region: 'Lima', latitude: -12.08, longitude: -76.95 },
  { id: 'san-miguel', label: 'San Miguel', region: 'Lima', latitude: -12.077, longitude: -77.083 },
  { id: 'callao', label: 'Callao', region: 'Callao', latitude: -12.0566, longitude: -77.1181 },
  { id: 'ate', label: 'Ate', region: 'Lima', latitude: -12.026, longitude: -76.92 },
] as const;

export function findLocationPreset(id: string | null | undefined): LocationPreset | null {
  if (!id) return null;
  return LOCATION_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Zona más cercana a un punto (para etiquetar "cerca de …"). */
export function nearestLocationLabel(point: GeoPoint): string | null {
  let best: LocationPreset | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const preset of LOCATION_PRESETS) {
    const dLat = preset.latitude - point.latitude;
    const dLng = preset.longitude - point.longitude;
    const approx = dLat * dLat + dLng * dLng;
    if (approx < bestDistance) {
      bestDistance = approx;
      best = preset;
    }
  }

  // ~0.45 grados de diferencia cuadrática ≈ 50 km; más lejos no se etiqueta.
  return best && bestDistance <= 0.2 ? best.label : null;
}
