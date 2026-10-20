/**
 * lib/discovery.ts — contrato del buscador global (puro, sin DB).
 *
 * El endpoint `/api/search` y la home comparten estas reglas. La consulta SQL
 * aplica el mismo orden (relevancia → distancia → disponibilidad), pero la
 * decisión de qué es un parámetro válido vive acá y se testea sin PostgreSQL.
 */

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RADIUS_KM,
  MAX_RESULTS,
  parseRadius,
  type GeoPoint,
} from './geo';
import { formatMoney } from './format';

export const MAX_QUERY_LENGTH = 80;
export const MAX_OFFSET = 1000;

export interface DiscoveryQuery {
  q: string;
  location: GeoPoint | null;
  radiusKm: number;
  limit: number;
  offset: number;
}

export type QueryParseResult =
  | { ok: true; query: DiscoveryQuery }
  | { ok: false; status: number; code: string; message: string };

/**
 * Normaliza el texto: recorta, colapsa espacios y elimina caracteres de control.
 * No se hace `ILIKE` con el texto crudo: primero pasa por acá.
 */
export function normalizeQuery(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function parseInteger(raw: unknown, fallback: number): number | null {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function parseCoordinate(raw: unknown, min: number, max: number): number | 'absent' | null {
  if (raw === null || raw === undefined || raw === '') return 'absent';
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/**
 * Valida los parámetros de `GET /api/search`:
 *   ?q=arroz&lat=-12.04&lng=-77.03&radius=5&limit=20&offset=0
 *
 * Coordenadas: van juntas o no van. Sin coordenadas la búsqueda es global (la
 * app nunca se bloquea por falta de GPS).
 */
export function parseDiscoveryQuery(searchParams: URLSearchParams): QueryParseResult {
  const q = normalizeQuery(searchParams.get('q'));

  const lat = parseCoordinate(searchParams.get('lat'), -90, 90);
  const lng = parseCoordinate(searchParams.get('lng'), -180, 180);

  if (lat === null || lng === null) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_coordinates',
      message: 'lat debe estar entre -90 y 90 y lng entre -180 y 180.',
    };
  }
  if ((lat === 'absent') !== (lng === 'absent')) {
    return {
      ok: false,
      status: 400,
      code: 'incomplete_coordinates',
      message: 'lat y lng deben enviarse juntos.',
    };
  }

  const radiusKm = parseRadius(searchParams.get('radius'));
  if (radiusKm === null) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_radius',
      message: 'radius debe estar entre 1 y 50 km.',
    };
  }

  const limit = parseInteger(searchParams.get('limit'), DEFAULT_PAGE_SIZE);
  if (limit === null || limit < 1 || limit > MAX_RESULTS) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_limit',
      message: `limit debe ser un entero entre 1 y ${MAX_RESULTS}.`,
    };
  }

  const offset = parseInteger(searchParams.get('offset'), 0);
  if (offset === null || offset < 0 || offset > MAX_OFFSET) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_offset',
      message: `offset debe ser un entero entre 0 y ${MAX_OFFSET}.`,
    };
  }

  return {
    ok: true,
    query: {
      q,
      location: lat === 'absent' || lng === 'absent' ? null : { latitude: lat, longitude: lng },
      radiusKm: radiusKm ?? DEFAULT_RADIUS_KM,
      limit,
      offset,
    },
  };
}

// =============================================================================
//  RESULTADOS
// =============================================================================

export interface DiscoveryProduct {
  storeId: string;
  storeSlug: string;
  storeName: string;
  storeCategory: string | null;
  productSlug: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  priceCents: number;
  currency: string;
  unit: string;
  available: number;
  inStock: boolean;
  distanceKm: number | null;
  /** Cantidad de variantes activas; `priceCents` es el mínimo en ese caso. */
  variantCount: number;
  hasVariants: boolean;
}

export interface DiscoveryStore {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  logoUrl: string | null;
  distanceKm: number | null;
  productCount: number;
  inStockCount: number;
}

export interface DiscoveryMetadata {
  q: string;
  location: GeoPoint | null;
  radiusKm: number;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  generatedAt: string;
}

export interface DiscoveryResponse {
  products: DiscoveryProduct[];
  stores: DiscoveryStore[];
  metadata: DiscoveryMetadata;
}

/**
 * Ranking de relevancia que replica el CASE de SQL. Se expone para tests y para
 * que el contrato sea explícito:
 *   0 nombre exacto · 1 nombre empieza con · 2 nombre contiene
 *   3 marca/categoría contiene · 4 solo coincide el maestro · 5 sin texto
 */
export function relevanceRank(
  product: { name: string; brand?: string | null; category?: string | null; masterName?: string | null },
  query: string,
): number {
  const q = normalizeQuery(query).toLowerCase();
  if (!q) return 5;

  const name = product.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;

  const secondary = [product.brand, product.category]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());
  if (secondary.some((value) => value.includes(q))) return 3;

  const master = (product.masterName ?? '').toLowerCase();
  if (master.includes(q)) return 4;

  return 5;
}

/** Orden estable y explicable: relevancia, distancia, disponibilidad, nombre. */
export function compareDiscoveryProducts(
  a: DiscoveryProduct,
  b: DiscoveryProduct,
  query: string,
): number {
  const rankA = relevanceRank(a, query);
  const rankB = relevanceRank(b, query);
  if (rankA !== rankB) return rankA - rankB;

  if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) {
    return a.distanceKm - b.distanceKm;
  }
  if (a.distanceKm === null && b.distanceKm !== null) return 1;
  if (a.distanceKm !== null && b.distanceKm === null) return -1;

  if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
  if (a.priceCents !== b.priceCents) return a.priceCents - b.priceCents;
  return a.name.localeCompare(b.name, 'es');
}

// =============================================================================
//  PRESENTACIÓN
// =============================================================================

/**
 * Dinero siempre en centavos enteros; acá se formatea para mostrar.
 * Delega en `lib/format.ts` (única fuente de formato de la UI).
 */
export function formatPriceCents(cents: number, currency = 'PEN', locale: 'es' | 'en' = 'es'): string {
  return formatMoney(cents, currency, locale);
}

export function priceToCents(price: number): number {
  if (!Number.isFinite(price) || price < 0) return 0;
  return Math.round(price * 100);
}
