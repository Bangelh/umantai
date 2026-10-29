'use client';

/**
 * MapCanvas — mapa interactivo con pin arrastrable (MapLibre GL).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DECISIONES
 *
 *  · MapLibre (open source) y no Google Maps: el mapa no depende del proveedor
 *    de geocoding. Cambiar de tiles es cambiar `NEXT_PUBLIC_MAP_TILES_URL`.
 *  · El pin es SIEMPRE arrastrable y el mapa acepta clic para moverlo: es la
 *    salida cuando el geocoder no reconoce la dirección.
 *  · La librería se importa en el navegador (dynamic import): no pesa en el
 *    bundle inicial del panel ni en el HTML del servidor.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';

import 'maplibre-gl/dist/maplibre-gl.css';

export interface MapCanvasPoint {
  latitude: number;
  longitude: number;
}

interface Props {
  center: MapCanvasPoint;
  marker: MapCanvasPoint | null;
  onMarkerChange: (point: MapCanvasPoint) => void;
  /** Texto accesible del mapa (no se muestra como etiqueta flotante). */
  label: string;
  className?: string;
}

const TILES_URL =
  process.env.NEXT_PUBLIC_MAP_TILES_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * Atribución obligatoria, SIEMPRE visible (sin botón ⓘ que la esconda).
 *
 * · OpenStreetMap: los datos y las teselas son OSM, con enlace a la página de
 *   copyright.
 * · Geoapify: sus Términos exigen atribución en el plan Free además de la de
 *   OSM, aunque el mapa use teselas de OSM.
 *
 * Va como `customAttribution` (HTML con enlaces) y no como atribución de la
 * fuente: MapLibre pinta esta última como texto plano, sin enlace.
 */
const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
const GEOAPIFY_ATTRIBUTION =
  '<a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a>';

/** Estilo mínimo con teselas ráster: sin key ni servicios de terceros atados. */
function rasterStyle() {
  return {
    version: 8 as const,
    sources: {
      base: {
        type: 'raster' as const,
        tiles: [TILES_URL],
        tileSize: 256,
        maxzoom: 19,
      },
    },
    layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
  };
}

export function MapCanvas({ center, marker, onMarkerChange, label, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<MapLibreMarker | null>(null);
  // El handler vive en una ref para que el efecto de montaje no se re-ejecute en
  // cada render (MapLibre no tolera recrear el mapa a cada tecla).
  const onChangeRef = useRef(onMarkerChange);
  useEffect(() => {
    onChangeRef.current = onMarkerChange;
  }, [onMarkerChange]);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const container = containerRef.current;
      if (!container) return;

      const maplibregl = (await import('maplibre-gl')).default;
      if (cancelled || !containerRef.current) return;

      const map = new maplibregl.Map({
        container,
        style: rasterStyle(),
        center: [center.longitude, center.latitude],
        zoom: 16,
        // La atribución se agrega a mano, siempre expandida.
        attributionControl: false,
      });
      mapRef.current = map;

      map.addControl(
        new maplibregl.AttributionControl({
          compact: false,
          customAttribution: [OSM_ATTRIBUTION, GEOAPIFY_ATTRIBUTION],
        }),
        'bottom-right',
      );
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

      map.on('click', (event) => {
        onChangeRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
      });

      if (marker) {
        markerRef.current = new maplibregl.Marker({ draggable: true, color: '#111827' })
          .setLngLat([marker.longitude, marker.latitude])
          .addTo(map);
        markerRef.current.on('dragend', () => {
          const position = markerRef.current?.getLngLat();
          if (position) onChangeRef.current({ latitude: position.lat, longitude: position.lng });
        });
      }
    }

    void boot();

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // El mapa se crea una sola vez; centro y pin se sincronizan en los efectos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mantener el marcador sincronizado con el estado del formulario.
  useEffect(() => {
    let cancelled = false;

    async function sync() {
      const map = mapRef.current;
      if (!map) return;
      const maplibregl = (await import('maplibre-gl')).default;
      if (cancelled || !mapRef.current) return;

      if (!marker) {
        markerRef.current?.remove();
        markerRef.current = null;
        return;
      }
      if (!markerRef.current) {
        markerRef.current = new maplibregl.Marker({ draggable: true, color: '#111827' })
          .setLngLat([marker.longitude, marker.latitude])
          .addTo(map);
        markerRef.current.on('dragend', () => {
          const position = markerRef.current?.getLngLat();
          if (position) onChangeRef.current({ latitude: position.lat, longitude: position.lng });
        });
        return;
      }
      const current = markerRef.current.getLngLat();
      if (Math.abs(current.lat - marker.latitude) > 1e-7 || Math.abs(current.lng - marker.longitude) > 1e-7) {
        markerRef.current.setLngLat([marker.longitude, marker.latitude]);
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [marker]);

  // Centrar sin pelear con el arrastre del usuario.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = map.getCenter();
    if (Math.abs(current.lat - center.latitude) < 1e-4 && Math.abs(current.lng - center.longitude) < 1e-4) {
      return;
    }
    map.easeTo({ center: [center.longitude, center.latitude], duration: 400 });
  }, [center]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={label}
      className={className ?? 'h-64 w-full overflow-hidden rounded-2xl border border-border'}
    />
  );
}
