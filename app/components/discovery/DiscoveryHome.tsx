'use client';

/**
 * app/components/discovery/DiscoveryHome.tsx — buscador local de la home.
 *
 * PRIORIDADES DE DISEÑO
 *   · Densidad: filas compactas, SIN fotografía de producto.
 *   · Precio muy visible, tipografía monoespaciada y tabular.
 *   · Uso con una mano: controles grandes arriba, resultados debajo.
 *   · Velocidad: una sola API (`/api/search`), debounce de 300 ms y
 *     `AbortController` para descartar respuestas viejas.
 *
 * PRIVACIDAD
 *   · La geolocalización NO se pide sola: el usuario pulsa "Usar mi ubicación".
 *   · La coordenada se guarda en `sessionStorage` (se borra al cerrar la
 *     pestaña), nunca en localStorage ni en el servidor.
 *   · Si rechaza el GPS, hay selección manual de zona/coordenadas.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RADIUS_KM,
  RADIUS_OPTIONS_KM,
  formatDistanceKm,
  type GeoPoint,
} from '@/lib/geo';
import { formatCoordinates } from '@/lib/format';
import { formatPriceCents, type DiscoveryResponse } from '@/lib/discovery';
import { LOCATION_PRESETS, nearestLocationLabel } from '@/lib/locations';
import { useI18n } from '@/components/i18n/I18nProvider';

const GEO_STORAGE_KEY = 'umantai:geo';
const DEBOUNCE_MS = 300;

interface Props {
  initial: DiscoveryResponse;
}

interface GeoSession {
  latitude: number;
  longitude: number;
}

function readSessionGeo(): GeoSession | null {
  try {
    const raw = window.sessionStorage.getItem(GEO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GeoSession>;
    if (
      typeof parsed.latitude === 'number' &&
      Number.isFinite(parsed.latitude) &&
      typeof parsed.longitude === 'number' &&
      Number.isFinite(parsed.longitude)
    ) {
      return { latitude: parsed.latitude, longitude: parsed.longitude };
    }
  } catch {
    /* sessionStorage bloqueado o JSON inválido */
  }
  return null;
}

function writeSessionGeo(point: GeoSession | null): void {
  try {
    if (point) window.sessionStorage.setItem(GEO_STORAGE_KEY, JSON.stringify(point));
    else window.sessionStorage.removeItem(GEO_STORAGE_KEY);
  } catch {
    /* almacenamiento no disponible: la ubicación vive solo en memoria */
  }
}

export function DiscoveryHome({ initial }: Props) {
  const { locale, t } = useI18n();
  const [q, setQ] = useState('');
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [results, setResults] = useState<DiscoveryResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geoStatus, setGeoStatus] = useState<'idle' | 'asking' | 'denied' | 'unavailable'>('idle');
  const [showManual, setShowManual] = useState(false);
  const [manualId, setManualId] = useState('');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');

  const initialRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);

  const locationLabel = useMemo(() => {
    if (!location) return null;
    return nearestLocationLabel(location) ?? formatCoordinates(location.latitude, location.longitude);
  }, [location]);

  // Restaura la ubicación de ESTA pestaña (si el usuario ya la eligió).
  // Se difiere al siguiente tick para que la hidratación termine antes de
  // cambiar el estado (evita mismatch server/cliente y renders en cascada).
  useEffect(() => {
    const stored = readSessionGeo();
    if (!stored) return;
    const timer = window.setTimeout(() => setLocation(stored), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const runSearch = useCallback(
    async (query: string, point: GeoPoint | null, radius: number) => {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (point) {
        params.set('lat', String(point.latitude));
        params.set('lng', String(point.longitude));
        params.set('radius', String(radius));
      }
      params.set('limit', '30');

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++requestSeq.current;

      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/search?${params.toString()}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? t('search.failed'));
        }
        const payload = (await response.json()) as DiscoveryResponse;
        if (seq === requestSeq.current) setResults(payload);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('search.failed'));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [t],
  );

  // Debounce: primera renderización ya trae datos del servidor; no se repite.
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void runSearch(q, location, radiusKm);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, location, radiusKm, runSearch]);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setGeoStatus('unavailable');
      setShowManual(true);
      return;
    }

    setGeoStatus('asking');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setLocation(point);
        writeSessionGeo(point);
        setGeoStatus('idle');
        setShowManual(false);
      },
      () => {
        // Permiso denegado, timeout o GPS apagado: NUNCA se bloquea la app.
        setGeoStatus('denied');
        setShowManual(true);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  };

  const clearLocation = () => {
    setLocation(null);
    writeSessionGeo(null);
    setGeoStatus('idle');
  };

  const applyManualPreset = () => {
    const preset = LOCATION_PRESETS.find((item) => item.id === manualId);
    if (!preset) return;
    const point = { latitude: preset.latitude, longitude: preset.longitude };
    setLocation(point);
    writeSessionGeo(point);
    setShowManual(false);
  };

  const applyManualCoords = () => {
    const lat = Number(manualLat);
    const lng = Number(manualLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setError(t('geo.invalidCoords'));
      return;
    }
    const point = { latitude: lat, longitude: lng };
    setLocation(point);
    writeSessionGeo(point);
    setShowManual(false);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      {/* Buscador */}
      <section aria-label={t('search.section')} className="pt-6 sm:pt-8">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(q, location, radiusKm);
          }}
          className="flex items-center gap-2"
        >
          <label htmlFor="discovery-q" className="sr-only">
            {t('search.label')}
          </label>
          <div className="relative flex-1">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-tertiary"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="discovery-q"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              maxLength={80}
              autoComplete="off"
              placeholder={t('search.placeholder')}
              className="h-14 w-full rounded-2xl border border-border-strong bg-surface pl-12 pr-4 text-base outline-none placeholder:text-muted focus:border-primary"
            />
          </div>
          <button
            type="submit"
            className="h-14 shrink-0 rounded-2xl bg-brand px-5 text-sm font-semibold text-background hover:opacity-90"
          >
            {t('search.submit')}
          </button>
        </form>
      </section>

      {/* Ubicación + radio */}
      <section aria-label={t('search.locationSection')} className="mt-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={useMyLocation}
            disabled={geoStatus === 'asking'}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-strong px-3 py-1.5 text-secondary hover:bg-surface-raised disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
            {geoStatus === 'asking' ? t('geo.locating') : location ? t('geo.update') : t('geo.use')}
          </button>

          {location && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1.5 text-success">
              {t('geo.near', { place: locationLabel ?? '' })}
              <button
                type="button"
                onClick={clearLocation}
                aria-label={t('geo.remove')}
                className="text-success/70 hover:text-success"
              >
                ×
              </button>
            </span>
          )}

          <button
            type="button"
            onClick={() => setShowManual((value) => !value)}
            aria-expanded={showManual}
            className="rounded-full px-2 py-1.5 text-tertiary underline-offset-2 hover:text-primary hover:underline"
          >
            {t('geo.manual')}
          </button>
        </div>

        {geoStatus === 'denied' && (
          <p className="mt-2 text-xs text-warning">{t('geo.denied')}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('search.locationSection')}>
          <span className="mr-1 text-xs uppercase tracking-[1.5px] text-muted">{t('geo.radius')}</span>
          {RADIUS_OPTIONS_KM.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRadiusKm(option)}
              aria-pressed={radiusKm === option}
              className={`rounded-full border px-3 py-1 text-xs tabular-nums transition-colors ${
                radiusKm === option
                  ? 'border-brand bg-brand text-background'
                  : 'border-border text-secondary hover:border-border-strong'
              }`}
            >
              {option} km
            </button>
          ))}
        </div>

        {showManual && (
          <div className="mt-3 rounded-2xl border border-border bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex-1 text-xs text-tertiary">
                {t('geo.zone')}
                <select
                  value={manualId}
                  onChange={(event) => setManualId(event.target.value)}
                  className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
                >
                  <option value="">{t('geo.selectZone')}</option>
                  {LOCATION_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label} · {preset.region}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={applyManualPreset}
                disabled={!manualId}
                className="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-40"
              >
                {t('geo.useZone')}
              </button>
            </div>

            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-tertiary hover:text-primary">
                {t('geo.coords')}
              </summary>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 text-xs text-tertiary">
                  {t('geo.latitude')}
                  <input
                    value={manualLat}
                    onChange={(event) => setManualLat(event.target.value)}
                    inputMode="decimal"
                    placeholder="-12.0464"
                    className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm"
                  />
                </label>
                <label className="flex-1 text-xs text-tertiary">
                  {t('geo.longitude')}
                  <input
                    value={manualLng}
                    onChange={(event) => setManualLng(event.target.value)}
                    inputMode="decimal"
                    placeholder="-77.0428"
                    className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm"
                  />
                </label>
                <button
                  type="button"
                  onClick={applyManualCoords}
                  className="h-10 rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
                >
                  {t('geo.apply')}
                </button>
              </div>
            </details>
          </div>
        )}
      </section>

      {/* Resultados */}
      <section aria-label={t('search.resultsSection')} className="mt-6">
        <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {q.trim()
              ? t('search.resultsFor', { query: q.trim() })
              : location
                ? t('search.productsNearby')
                : t('search.allProducts')}
          </h2>
          <span className="text-xs text-muted tabular-nums">
            {loading
              ? t('search.searching')
              : t(results.metadata.total === 1 ? 'search.productCountOne' : 'search.productCountMany', {
                  count: results.metadata.total,
                })}
          </span>
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && results.products.length === 0 ? (
          <ul className="animate-pulse divide-y divide-border" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <li key={index} className="flex items-center justify-between gap-4 py-3">
                <div className="space-y-1.5">
                  <div className="h-4 w-40 rounded bg-surface-raised" />
                  <div className="h-3 w-24 rounded bg-surface-raised" />
                </div>
                <div className="h-4 w-16 rounded bg-surface-raised" />
              </li>
            ))}
          </ul>
        ) : results.products.length === 0 ? (
          <p className="py-6 text-sm text-tertiary">
            {location ? t('search.noResultsRadius') : t('search.noResults')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {results.products.map((product) => (
              <li key={`${product.storeId}:${product.productSlug}`}>
                <Link
                  href={`/${product.storeSlug}/p/${product.productSlug}`}
                  className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:bg-surface-raised/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium leading-tight text-primary">
                      {product.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-tertiary">
                      {product.storeName}
                      {product.distanceKm !== null && ` · ${formatDistanceKm(product.distanceKm, locale)}`}
                      {product.brand && ` · ${product.brand}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-[15px] font-semibold tabular-nums text-primary">
                      {product.hasVariants && (
                        <span className="mr-1 text-[10px] font-normal text-muted">{t('store.from')}</span>
                      )}
                      {formatPriceCents(product.priceCents, product.currency, locale)}
                    </span>
                    <span className={`mt-0.5 block text-[11px] font-medium ${product.inStock ? 'text-success' : 'text-destructive'}`}>
                      {product.inStock ? t('search.available') : t('search.outOfStock')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {results.metadata.total > results.products.length && (
          <p className="pt-3 text-xs text-muted">
            {t('search.showing', { shown: results.products.length, total: results.metadata.total })}
          </p>
        )}
      </section>

      {/* Tiendas cercanas */}
      <section aria-label={t('search.storesSection')} className="mt-8">
        <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {location ? t('search.storesNearby') : t('search.storesAll')}
          </h2>
          <span className="text-xs text-muted tabular-nums">{results.stores.length}</span>
        </div>

        {results.stores.length === 0 ? (
          <p className="py-5 text-sm text-tertiary">{t('search.noStores')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {results.stores.map((store) => (
              <li key={store.id}>
                <Link
                  href={`/${store.slug}`}
                  className="flex items-center gap-3 py-2.5 transition-colors hover:bg-surface-raised/60"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-raised text-sm font-semibold text-secondary">
                    {store.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- logo remoto del comercio
                      <img src={store.logoUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      store.name.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium leading-tight">{store.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-tertiary">
                      {store.category ?? t('search.merchantFallback')}
                      {store.distanceKm !== null && ` · ${formatDistanceKm(store.distanceKm, locale)}`}
                      {store.district && ` · ${store.district}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-tertiary">
                    <span className="block tabular-nums">
                      {t('search.storeAvailable', { count: store.inStockCount })}
                    </span>
                    <span className="block text-muted">
                      {t('search.storeProducts', { count: store.productCount })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* CTA comercios */}
      <section className="my-10 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <p className="text-xs uppercase tracking-[2px] text-muted">{t('home.businessKicker')}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">{t('home.businessTitle')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-secondary">{t('home.businessBody')}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Link
            href="/vender"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-brand px-5 text-sm font-semibold text-background hover:opacity-90"
          >
            {t('home.createStore')}
          </Link>
          <Link
            href="/vender#planes"
            className="inline-flex h-11 items-center justify-center rounded-xl border border-border-strong px-5 text-sm font-medium hover:bg-surface-raised"
          >
            {t('home.seePlans')}
          </Link>
        </div>
      </section>
    </div>
  );
}
