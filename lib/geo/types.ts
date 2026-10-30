/**
 * lib/geo/types.ts — contrato del dominio de ubicación.
 *
 * El dominio NO conoce Google Maps, Mapbox ni Geoapify: solo estas formas. Un
 * proveedor nuevo entra implementando `Geocoder` (lib/geo/providers/*), sin
 * tocar la base, la API de tiendas ni la UI.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Cadena administrativa resuelta desde un código UBIGEO. */
export interface UbigeoChain {
  code: string;
  department: string;
  province: string;
  district: string;
  /** Centroide del distrito (puede faltar en el snapshot). */
  centroid: GeoPoint | null;
}

export interface UbigeoOption {
  code: string;
  name: string;
}

export interface UbigeoDistrictOption extends UbigeoOption {
  latitude: number | null;
  longitude: number | null;
}

export interface GeocodeQuery {
  /** Calle y número tal como los escribió el comerciante. */
  address: string;
  /** Distrito elegido: acota la búsqueda y detecta coincidencias dudosas. */
  ubigeo?: UbigeoChain | null;
}

/**
 * Qué tan específica es la coincidencia según el proveedor.
 *
 * `administrative` (solo ciudad/distrito) NO es una dirección y la capa superior
 * la descarta: es la diferencia entre "encontramos tu calle" y "encontramos el
 * distrito, ubica el pin a mano".
 */
export type GeocodePrecision = 'exact' | 'approximate' | 'administrative' | 'unknown';

export interface GeocodeHit {
  point: GeoPoint;
  formatted: string;
  /**
   * `high` solo si el resultado identifica una vía, tiene rank suficiente y cae
   * en el distrito pedido. Cualquier otra cosa es `low`: se muestra el pin, pero
   * NUNCA se da por buena la coincidencia.
   */
  confidence: 'high' | 'low';
  /** Nombres administrativos que devolvió el proveedor (para diagnóstico). */
  department: string | null;
  province: string | null;
  district: string | null;
  /**
   * Nombres de distrito candidatos, del más específico al más general.
   *
   * En Perú el proveedor devuelve el barrio en `district` y el distrito real en
   * `city`; en Lima puede ser al revés. El servidor prueba cada candidato contra
   * el catálogo UBIGEO y solo acepta una coincidencia inequívoca.
   */
  districtCandidates: string[];
  /** Precisión declarada por el proveedor (no se inventa). */
  precision: GeocodePrecision;
  /**
   * Código UBIGEO resuelto por el SERVIDOR contra el catálogo INEI.
   * El proveedor nunca lo aporta y el cliente no lo puede imponer: sirve para
   * que la UI pueda PROPONER un cambio de distrito, nunca para aplicarlo sola.
   */
  ubigeo?: string | null;
}

export interface ReverseHit extends GeocodeHit {
  /** Dirección utilizable para precargar el formulario (sin número si falta). */
  addressLine: string | null;
  /** UBIGEO sugerido (solo si la coincidencia es inequívoca). */
  ubigeoHint: UbigeoChain | null;
}

export interface Geocoder {
  readonly name: string;
  readonly available: boolean;
  /** Dirección → punto. `null` si no hay coincidencia. */
  forward(query: GeocodeQuery): Promise<GeocodeHit | null>;
  /** Punto → dirección. `null` si no hay coincidencia. */
  reverse(point: GeoPoint): Promise<ReverseHit | null>;
}
