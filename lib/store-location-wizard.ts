/**
 * lib/store-location-wizard.ts — lógica pura del asistente de ubicación.
 *
 * Vive fuera del componente para poder probar el comportamiento que más duele
 * cuando se rompe: el asistente NUNCA cambia el distrito por su cuenta.
 *
 * Reglas:
 *   · GPS y geocoder solo PROPONEN un distrito; aplicarlo requiere que el
 *     usuario pulse «Usar esta ubicación». Mientras tanto la selección queda
 *     exactamente como estaba.
 *   · El resumen que se muestra antes de guardar se construye con las mismas
 *     piezas que el payload, así no puede decir una cosa y guardar otra.
 *   · Si el pin cae en el tramo `review` de `evaluatePinDistance` (lejos o muy
 *     lejos del centroide), no hay valor que guardar hasta que el usuario
 *     confirme que la ubicación es correcta.
 */

import type { GeoPoint } from './geo/types';
import { evaluatePinDistance, type PinDistanceVerdict } from './store-location';

export interface StoreLocationValue {
  ubigeo: string;
  address: string;
  reference: string | null;
  latitude: number;
  longitude: number;
  source: 'map_pin' | 'gps' | 'geocoder';
  /** El usuario confirmó explícitamente un pin del tramo intermedio. */
  confirmFarPin?: boolean;
}

export interface DistrictSelection {
  department: string;
  province: string;
  district: string;
}

export interface DistrictSuggestion {
  source: 'gps' | 'geocoder';
  code: string;
  /** "Trujillo, Trujillo, La Libertad" — tal como lo leyó el usuario. */
  label: string;
}

export interface DetectedDistrict {
  code?: string | null;
  district?: string | null;
  province?: string | null;
  department?: string | null;
}

/** "Distrito, Provincia, Departamento" omitiendo lo que falte. */
export function districtLabel(parts: DetectedDistrict | null | undefined): string {
  return [parts?.district, parts?.province, parts?.department]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * Propone cambiar de distrito. Devuelve `null` cuando no hay nada que proponer:
 * sin código válido, sin nombres o cuando el punto ya está en el distrito
 * seleccionado (en ese caso no se molesta al usuario).
 */
export function buildDistrictSuggestion(input: {
  source: 'gps' | 'geocoder';
  currentUbigeo: string;
  detected: DetectedDistrict | null | undefined;
}): DistrictSuggestion | null {
  const code = typeof input.detected?.code === 'string' ? input.detected.code.trim() : '';
  if (!/^[0-9]{6}$/.test(code)) return null;
  if (code === input.currentUbigeo) return null;

  const label = districtLabel(input.detected);
  if (label.length === 0) return null;

  return { source: input.source, code, label };
}

/** Aplica la sugerencia. Los códigos UBIGEO son jerárquicos: 2/4/6 dígitos. */
export function applyDistrictSuggestion(
  _selection: DistrictSelection,
  suggestion: DistrictSuggestion,
): DistrictSelection {
  return {
    department: suggestion.code.slice(0, 2),
    province: suggestion.code.slice(0, 4),
    district: suggestion.code,
  };
}

/**
 * Único lugar que decide si la selección cambia. Con `keep` se devuelve la
 * selección actual sin tocar: es el camino de «Mantener mi selección».
 */
export function resolveSuggestionChoice(
  selection: DistrictSelection,
  suggestion: DistrictSuggestion | null,
  choice: 'use' | 'keep',
): DistrictSelection {
  if (choice !== 'use' || !suggestion) return selection;
  return applyDistrictSuggestion(selection, suggestion);
}

export interface LocationSummary {
  ubigeo: string;
  department: string | null;
  province: string | null;
  district: string | null;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * Resumen de lo que se va a guardar. Usa la misma dirección y el mismo pin que
 * `buildLocationValue`, y los nombres del catálogo que el trigger escribirá en
 * la base.
 */
export function buildLocationSummary(input: {
  ubigeo: string;
  address: string;
  marker: GeoPoint | null;
  names: { department?: string | null; province?: string | null; district?: string | null };
}): LocationSummary | null {
  if (!/^[0-9]{6}$/.test(input.ubigeo)) return null;
  const address = input.address.trim();
  if (address.length < 3) return null;
  if (!input.marker) return null;

  return {
    ubigeo: input.ubigeo,
    department: input.names.department ?? null,
    province: input.names.province ?? null,
    district: input.names.district ?? null,
    address,
    latitude: input.marker.latitude,
    longitude: input.marker.longitude,
  };
}

/**
 * Payload listo para persistir. Devuelve `null` si falta algo o si el pin
 * todavía no fue confirmado en el tramo de aviso por distancia: así el botón de
 * confirmar no puede enviar una ubicación que la API va a rechazar.
 */
export function buildLocationValue(input: {
  ubigeo: string;
  address: string;
  reference: string;
  marker: GeoPoint | null;
  source: StoreLocationValue['source'];
  pin: PinDistanceVerdict;
}): StoreLocationValue | null {
  if (!/^[0-9]{6}$/.test(input.ubigeo)) return null;
  const address = input.address.trim();
  if (address.length < 3) return null;
  if (!input.marker) return null;
  if (input.pin.level !== 'ok') return null;

  const reference = input.reference.trim();
  return {
    ubigeo: input.ubigeo,
    address,
    reference: reference.length > 0 ? reference : null,
    latitude: input.marker.latitude,
    longitude: input.marker.longitude,
    source: input.source,
    ...(input.pin.warnings.length > 0 ? { confirmFarPin: true } : {}),
  };
}

/** Reexportado para que la UI calcule la guarda con el mismo criterio. */
export { evaluatePinDistance };
