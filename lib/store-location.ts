/**
 * lib/store-location.ts — validación del payload de ubicación de una tienda.
 *
 * Puro (sin DB ni red): la ruta valida la forma y la pertenencia al Perú acá, y
 * después confirma contra la base que el UBIGEO exista. Así el mismo criterio se
 * usa en el alta, en la edición y en los tests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ ES CANÓNICO
 *
 *   · `ubigeo`                → referencia administrativa (FK al catálogo INEI)
 *   · `latitude`/`longitude`  → el PIN exacto y lo único que usa el buscador
 *   · `address`, `reference`  → texto saneado que escribe el comerciante
 *
 *  `department` / `province` / `district` / `city` NO se aceptan del cliente:
 *  los deriva el trigger de la base desde el UBIGEO (ver migración 025).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isPointInPeru, sanitizeAddress, sanitizeReference } from './geo/peru';
import type { GeoPoint } from './geo/types';

export const LOCATION_SOURCES = ['map_pin', 'gps', 'geocoder', 'legacy_zone'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export interface StoreLocationInput {
  ubigeo: string;
  address: string;
  reference: string | null;
  latitude: number;
  longitude: number;
  source: LocationSource;
}

export type StoreLocationWarning = 'pin_far_from_district';

export type StoreLocationValidation =
  | { ok: true; value: StoreLocationInput; warnings: StoreLocationWarning[] }
  | { ok: false; code: string; message: string; field: string };

const UBIGEO = /^[0-9]{6}$/;

function fail(code: string, message: string, field: string): StoreLocationValidation {
  return { ok: false, code, message, field };
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Valida el payload de ubicación.
 *
 * `warnings` no bloquea: la comparación con el centroide del distrito es una
 * advertencia, porque un centroide no representa los límites reales.
 */
export function validateStoreLocation(
  raw: unknown,
  options: { nearCentroidKm?: number | null } = {},
): StoreLocationValidation {
  if (!raw || typeof raw !== 'object') {
    return fail('invalid_location', 'Faltan los datos de ubicación.', 'location');
  }
  const body = raw as Record<string, unknown>;

  const ubigeo = typeof body.ubigeo === 'string' ? body.ubigeo.trim() : '';
  if (!UBIGEO.test(ubigeo)) {
    return fail(
      'invalid_ubigeo',
      'Elige departamento, provincia y distrito.',
      'ubigeo',
    );
  }

  const address = sanitizeAddress(body.address);
  if (!address || address.length < 3) {
    return fail('invalid_address', 'Escribe la dirección de tu tienda.', 'address');
  }

  const rawReference = body.reference;
  let reference: string | null = null;
  if (rawReference !== undefined && rawReference !== null && rawReference !== '') {
    const cleaned = sanitizeReference(rawReference);
    if (cleaned === null) {
      return fail('invalid_reference', 'La referencia no es válida.', 'reference');
    }
    reference = cleaned;
  }

  const latitude = asFiniteNumber(body.latitude);
  const longitude = asFiniteNumber(body.longitude);
  if (latitude === null || longitude === null) {
    return fail(
      'invalid_point',
      'Mueve el marcador hasta la entrada de tu tienda.',
      'pin',
    );
  }

  const point: GeoPoint = { latitude, longitude };
  if (!isPointInPeru(point)) {
    return fail(
      'point_outside_peru',
      'La ubicación debe estar dentro del Perú.',
      'pin',
    );
  }

  const source = (typeof body.source === 'string' ? body.source : 'map_pin') as LocationSource;
  if (!LOCATION_SOURCES.includes(source)) {
    return fail('invalid_source', 'Origen de ubicación no válido.', 'source');
  }

  const warnings: StoreLocationWarning[] = [];
  const distance = options.nearCentroidKm;
  if (typeof distance === 'number' && Number.isFinite(distance) && distance > 60) {
    // El pin está lejos del centroide: puede ser correcto (distritos enormes o
    // rurales). Se guarda igual y se avisa en la respuesta.
    warnings.push('pin_far_from_district');
  }

  return {
    ok: true,
    value: { ubigeo, address, reference, latitude, longitude, source },
    warnings,
  };
}
