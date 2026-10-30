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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  GUARDA UBIGEO ↔ PIN (basada en centroide, NO en límites)
 *
 *  El centroide del distrito NO son sus límites y un distrito grande o rural
 *  puede tener puntos legítimos a más de 60 km del centro. Por eso esta guarda
 *  NUNCA bloquea: solo sube el nivel de fricción.
 *
 *    · ≤ PIN_REVIEW_KM   → se guarda sin fricción;
 *    · ≤ PIN_CRITICAL_KM → advertencia + confirmación explícita (`confirmFarPin`);
 *    · > PIN_CRITICAL_KM → advertencia CRÍTICA + confirmación explícita. Se puede
 *                          guardar, porque el centroide no prueba nada.
 *
 *  PENDIENTE (validación territorial estricta): cuando existan polígonos
 *  administrativos reales (límites distritales oficiales), reemplazar esta
 *  heurística por `point-in-polygon` contra el polígono del UBIGEO. Solo entonces
 *  tendría sentido rechazar un pin por estar fuera del distrito. Hasta ahora el
 *  centroide es únicamente un detector de errores obvios.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { distanceKm, isPointInPeru, sanitizeAddress, sanitizeReference } from './geo/peru';
import type { GeoPoint } from './geo/types';

export const LOCATION_SOURCES = ['map_pin', 'gps', 'geocoder', 'legacy_zone'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/** A partir de acá el guardado pide una confirmación explícita del usuario. */
export const PIN_REVIEW_KM = 25;
/** A partir de acá la advertencia es crítica (sigue sin bloquear). */
export const PIN_CRITICAL_KM = 60;

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

/**
 * Resultado de comparar el pin con el centroide del distrito elegido.
 *
 * `review` NO es un bloqueo: la UI muestra una advertencia (normal o crítica) y
 * exige que el usuario confirme. Con `confirmed: true` pasa a `ok` y se guarda.
 */
export type PinDistanceVerdict =
  | { level: 'ok'; km: number | null; warnings: StoreLocationWarning[] }
  | {
      level: 'review';
      km: number;
      severity: 'warn' | 'critical';
      code: 'pin_confirmation_required';
      message: string;
      warnings: ['pin_far_from_district'];
    };

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
 * Compara el pin con el centroide del distrito. Nunca bloquea.
 *
 * Sin centroide (distrito del snapshot sin coordenadas) la guarda no opina: no
 * hay con qué comparar.
 *
 * `confirmed` refleja que el usuario vio la advertencia y afirmó que el pin es
 * correcto. Es lo único que separa `review` de `ok`.
 */
export function evaluatePinDistance(
  centroid: GeoPoint | null,
  pin: GeoPoint,
  options: { confirmed?: boolean } = {},
): PinDistanceVerdict {
  if (!centroid) return { level: 'ok', km: null, warnings: [] };

  const km = distanceKm(centroid, pin);
  if (!Number.isFinite(km)) return { level: 'ok', km: null, warnings: [] };

  if (km <= PIN_REVIEW_KM) return { level: 'ok', km, warnings: [] };

  if (options.confirmed) return { level: 'ok', km, warnings: ['pin_far_from_district'] };

  return {
    level: 'review',
    km,
    severity: km > PIN_CRITICAL_KM ? 'critical' : 'warn',
    code: 'pin_confirmation_required',
    message:
      km > PIN_CRITICAL_KM
        ? 'El marcador está muy lejos del centro del distrito elegido. Revisa que el distrito y el punto sean correctos antes de continuar.'
        : 'El marcador está lejos del centro del distrito. Confírmalo antes de guardar.',
    warnings: ['pin_far_from_district'],
  };
}

/**
 * Valida la FORMA del payload de ubicación.
 *
 * La distancia al centroide se evalúa aparte (`evaluatePinDistance`), cuando la
 * ruta ya resolvió la cadena UBIGEO.
 */
export function validateStoreLocation(raw: unknown): StoreLocationValidation {
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

  return {
    ok: true,
    value: { ubigeo, address, reference, latitude, longitude, source },
    warnings: [],
  };
}

/** `true` solo si el cliente mandó la confirmación del aviso de distancia. */
export function readFarPinConfirmation(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>).confirmFarPin === true;
}
