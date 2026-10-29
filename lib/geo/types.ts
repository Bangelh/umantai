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

export interface GeocodeHit {
  point: GeoPoint;
  formatted: string;
  /**
   * `high` solo si el resultado cae en el distrito pedido. Cualquier otra cosa
   * es `low`: se muestra el pin, pero NUNCA se da por buena la coincidencia.
   */
  confidence: 'high' | 'low';
  /** Nombres administrativos que devolvió el proveedor (para diagnóstico). */
  department: string | null;
  province: string | null;
  district: string | null;
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
