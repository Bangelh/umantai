'use client';

/**
 * app/components/discovery/DiscoveryHome.tsx — buscador y vidriera del home.
 *
 * MODO: Operate. El comprador viene a resolver una compra, no a mirar una
 * landing. La jerarquía es: buscar → ubicación → productos → tiendas → vender.
 *
 * DECISIONES DE DISEÑO
 *   · La lista NO lleva foto: densidad y precio comparables de un vistazo.
 *   · La foto aparece en la vista previa, donde sí ayuda a decidir.
 *   · La ubicación se ofrece como tarjeta al entrar, pero NUNCA se pide sola:
 *     el permiso del navegador lo dispara un clic explícito.
 *   · El radio se aplica a la búsqueda; el orden se puede cambiar entre
 *     cercanía y más vendidos sin volver a pedir datos.
 *   · Agregar desde la lista o la vista previa lanza una animación al carrito
 *     del header. El estado real sigue siendo el carrito de zustand.
 *
 * PRIVACIDAD
 *   · La coordenada vive en `sessionStorage` (se borra al cerrar la pestaña) y
 *     nunca se envía a un endpoint que la persista.
 */

import Link from 'next/link';
import { ArrowUpRight, MapPin, MessageCircle, Search, Store } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DEFAULT_RADIUS_KM,
  RADIUS_OPTIONS_KM,
  formatDistanceKm,
  type GeoPoint,
} from '@/lib/geo';
import { centsToUnits, formatCoordinates } from '@/lib/format';
import {
  formatPriceCents,
  type DiscoveryProduct,
  type DiscoveryResponse,
} from '@/lib/discovery';
import { nearestLocationLabel } from '@/lib/locations';
import { useCartStore, type CartConflict } from '@/lib/cartStore';
import type { Product } from '@/lib/products';
import { flyToCart } from '@/lib/fly-to-cart';
import { useI18n } from '@/components/i18n/I18nProvider';
import { EmptyState } from '@/components/ui/EmptyState';

const GEO_STORAGE_KEY = 'umantai:geo';
const DEBOUNCE_MS = 300;

interface Props {
  initial: DiscoveryResponse;
  businessWhatsAppUrl: string | null;
}

interface GeoSession {
  latitude: number;
  longitude: number;
}

type SortMode = 'nearby' | 'best';

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

export function DiscoveryHome({ initial, businessWhatsAppUrl }: Props) {
  const { locale, t } = useI18n();
  const [q, setQ] = useState('');
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [results, setResults] = useState<DiscoveryResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geoStatus, setGeoStatus] = useState<'idle' | 'asking' | 'denied' | 'unavailable'>('idle');
  const [sort, setSort] = useState<SortMode>('best');
  const [preview, setPreview] = useState<DiscoveryProduct | null>(null);
  const [cartConflict, setCartConflict] = useState<
    { conflict: CartConflict; product: DiscoveryProduct } | null
  >(null);

  const addItem = useCartStore((state) => state.addItem);
  const switchStore = useCartStore((state) => state.switchStore);
  const cartItems = useCartStore((state) => state.items);
  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  const initialRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);
  const keepCartRef = useRef<HTMLButtonElement>(null);
  const closePreviewRef = useRef<HTMLButtonElement>(null);

  const locationLabel = useMemo(() => {
    if (!location) return null;
    return nearestLocationLabel(location) ?? formatCoordinates(location.latitude, location.longitude);
  }, [location]);

  // Restaura la ubicación de ESTA pestaña (si el usuario ya la eligió).
  useEffect(() => {
    const stored = readSessionGeo();
    if (!stored) return;
    const timer = window.setTimeout(() => {
      setLocation(stored);
      setSort('nearby');
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // La pestaña móvil «Tienda» apunta a /#buscar: enfocar el campo evita que el
  // usuario llegue al inicio y tenga que buscar el control otra vez.
  useEffect(() => {
    const focusSearch = () => {
      if (window.location.hash !== '#buscar') return;
      document.getElementById('discovery-q')?.focus({ preventScroll: true });
    };
    const timer = window.setTimeout(focusSearch, 0);
    window.addEventListener('hashchange', focusSearch);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('hashchange', focusSearch);
    };
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

  // Debounce: la primera pintura ya trae datos del servidor.
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
        setSort('nearby');
        writeSessionGeo(point);
        setGeoStatus('idle');
      },
      () => {
        setGeoStatus('denied');
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  };

  const clearLocation = () => {
    setLocation(null);
    writeSessionGeo(null);
    setGeoStatus('idle');
  };

  useEffect(() => {
    if (!preview) return;
    closePreviewRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [preview]);

  useEffect(() => {
    if (!cartConflict) return;
    keepCartRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCartConflict(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cartConflict]);

  const snapshot = (product: DiscoveryProduct): Product => ({
    slug: product.productSlug,
    name: product.name,
    brand: product.brand ?? '',
    price: centsToUnits(product.priceCents),
    category: product.category ?? '',
    description: product.description ?? '',
    specs: [],
    inStock: product.available,
    rating: 0,
    reviewCount: 0,
    images: product.imageUrl ? [product.imageUrl] : [],
    storeId: product.storeId,
    storeSlug: product.storeSlug,
    storeName: product.storeName,
  });

  const add = (product: DiscoveryProduct, source: HTMLElement | null) => {
    if (!product.inStock || product.hasVariants) return;
    const result = addItem(snapshot(product), 1);
    if (result.status === 'conflict') {
      setCartConflict({ conflict: result, product });
      return;
    }
    flyToCart(source, product.imageUrl, product.name);
    toast.success(t('product.added', { quantity: 1, name: product.name }));
  };

  const confirmSwitch = () => {
    if (!cartConflict) return;
    const { product } = cartConflict;
    switchStore(snapshot(product), 1);
    toast.success(t('product.switched', { store: product.storeName }));
    setCartConflict(null);
  };

  const sortedProducts = useMemo(() => {
    const list = [...results.products];
    if (sort === 'best') {
      list.sort((a, b) => {
        if (b.soldCount !== a.soldCount) return b.soldCount - a.soldCount;
        if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
        return 0;
      });
    }
    return list;
  }, [results.products, sort]);

  const previewInCart = preview
    ? cartItems
        .filter(
          (item) => item.storeSlug === preview.storeSlug && item.slug === preview.productSlug,
        )
        .reduce((sum, item) => sum + item.quantity, 0)
    : 0;

  const previewAddress = preview
    ? [preview.storeAddress, preview.storeDistrict].filter(Boolean).join(', ')
    : '';

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      {/* Buscador y ubicación: un solo bloque dominante. */}
      <section
        id="buscar"
        aria-label={t('search.section')}
        className="scroll-mt-24 pt-5 sm:pt-6"
      >
        <div className="surface-card relative overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent"
          />
          <form
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(q, location, radiusKm);
            }}
            className="relative flex items-center gap-2 p-3 sm:p-4"
          >
          <label htmlFor="discovery-q" className="sr-only">
            {t('search.label')}
          </label>
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-tertiary"
              strokeWidth={2}
            />
            <input
              id="discovery-q"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              maxLength={80}
              autoComplete="off"
              placeholder={t('search.placeholder')}
              className="h-14 w-full rounded-xl border border-border-strong bg-background pl-12 pr-4 text-base placeholder:text-muted focus:border-brand"
            />
          </div>
          <button
            type="submit"
            className="h-14 shrink-0 rounded-xl bg-brand px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90 sm:px-5"
          >
            {t('search.submit')}
          </button>
          </form>

          <div
            role="group"
            aria-label={t('search.locationSection')}
            className="relative border-t border-border bg-surface-raised/20 px-3 py-3 sm:px-4"
          >
            {!location ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  type="button"
                  onClick={useMyLocation}
                  disabled={geoStatus === 'asking'}
                  className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border-strong bg-surface px-3 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised disabled:opacity-60"
                >
                  <MapPin aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                  {geoStatus === 'asking' ? t('geo.locating') : t('geo.use')}
                </button>
                <span className="text-xs leading-relaxed text-muted">{t('home.locationPrivacy')}</span>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-success/40 bg-success/10 px-3 text-sm font-medium text-success">
                    <MapPin aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                    {t('geo.near', { place: locationLabel ?? '' })}
                    <button
                      type="button"
                      onClick={clearLocation}
                      aria-label={t('geo.remove')}
                      className="ml-0.5 text-base leading-none text-success/70 hover:text-success"
                    >
                      ×
                    </button>
                  </span>
                  <button
                    type="button"
                    onClick={useMyLocation}
                    disabled={geoStatus === 'asking'}
                    className="min-h-10 rounded-full px-2 text-xs text-tertiary underline-offset-4 hover:text-primary hover:underline disabled:opacity-60"
                  >
                    {geoStatus === 'asking' ? t('geo.locating') : t('geo.update')}
                  </button>
                </div>

                <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
                  <span className="mr-1 shrink-0 text-[11px] font-medium uppercase tracking-[1.5px] text-muted">
                    {t('geo.radius')}
                  </span>
                  {RADIUS_OPTIONS_KM.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setRadiusKm(option)}
                      aria-pressed={radiusKm === option}
                      className={`shrink-0 rounded-full border px-3 py-1 text-xs tabular-nums transition-colors ${
                        radiusKm === option
                          ? 'border-brand bg-brand text-background'
                          : 'border-border text-secondary hover:border-border-strong'
                      }`}
                    >
                      {option} km
                    </button>
                  ))}
                </div>
              </>
            )}

            {geoStatus === 'denied' && (
              <p className="mt-2 text-xs text-warning">{t('geo.denied')}</p>
            )}
            {geoStatus === 'unavailable' && (
              <p className="mt-2 text-xs text-warning">{t('geo.denied')}</p>
            )}
          </div>
        </div>
      </section>

      {/* Resultados */}
      <section aria-label={t('search.resultsSection')} className="mt-9">
        <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {q.trim()
                ? t('search.resultsFor', { query: q.trim() })
                : location
                  ? t('search.productsNearby')
                  : t('search.allProducts')}
            </h2>
            <p className="mt-1 text-sm text-secondary">
              {sort === 'best' ? t('home.sortBestNote') : t('home.sortNearbyNote')}
            </p>
          </div>
          <span
            aria-live="polite"
            className="inline-flex w-fit items-center rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-secondary tabular-nums"
          >
            {loading
              ? t('search.searching')
              : t(results.metadata.total === 1 ? 'search.productCountOne' : 'search.productCountMany', {
                  count: results.metadata.total,
                })}
          </span>
        </div>

        {results.products.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-full border border-border bg-surface p-0.5"
              role="group"
              aria-label={t('home.sortLabel')}
            >
            <button
              type="button"
              onClick={() => setSort('nearby')}
              aria-pressed={sort === 'nearby'}
              disabled={!location}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                sort === 'nearby' ? 'bg-brand text-background' : 'text-secondary hover:text-primary'
              }`}
            >
              {t('home.sortNearby')}
            </button>
            <button
              type="button"
              onClick={() => setSort('best')}
              aria-pressed={sort === 'best'}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                sort === 'best' ? 'bg-brand text-background' : 'text-secondary hover:text-primary'
              }`}
            >
              {t('home.sortBest')}
            </button>
            </div>
            {!location && (
              <span className="text-xs text-muted">{t('home.sortNearbyHint')}</span>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-3.5 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && results.products.length === 0 ? (
          <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-surface">
            <ul className="animate-pulse divide-y divide-border" aria-hidden="true">
              {Array.from({ length: 6 }).map((_, index) => (
                <li key={index} className="flex items-center justify-between gap-4 px-4 py-4">
                  <div className="space-y-1.5">
                    <div className="h-4 w-40 rounded bg-surface-raised" />
                    <div className="h-3 w-24 rounded bg-surface-raised" />
                  </div>
                  <div className="h-4 w-16 rounded bg-surface-raised" />
                </li>
              ))}
            </ul>
          </div>
        ) : results.products.length === 0 ? (
          <EmptyState
            align="center"
            icon={Search}
            title={t('search.noResultsTitle')}
            description={location ? t('search.noResultsRadius') : t('search.noResults')}
            action={
              q.trim() ? (
                <button type="button" onClick={() => setQ('')} className="btn-secondary text-sm">
                  {t('search.clearQuery')}
                </button>
              ) : location ? (
                <button type="button" onClick={clearLocation} className="btn-secondary text-sm">
                  {t('search.clearLocation')}
                </button>
              ) : undefined
            }
            className="mt-3"
          />
        ) : (
          <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-surface">
            <ul className="divide-y divide-border">
              {sortedProducts.map((product) => (
                <li
                  key={`${product.storeId}:${product.productSlug}`}
                  className="flex items-center gap-2 px-3 py-3.5 sm:px-4"
                >
                <button
                  type="button"
                  onClick={() => setPreview(product)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-1 py-1 text-left transition-colors hover:bg-surface-raised/60"
                  aria-label={t('home.previewAria', { name: product.name })}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium leading-tight text-primary">
                      {product.name}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-tertiary">
                      {product.storeName}
                      {product.distanceKm !== null && ` · ${formatDistanceKm(product.distanceKm, locale)}`}
                      {product.brand && ` · ${product.brand}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-body-lg font-semibold tabular-nums text-primary">
                      {product.hasVariants && (
                        <span className="mr-1 text-xs font-normal text-muted">{t('store.from')}</span>
                      )}
                      {formatPriceCents(product.priceCents, product.currency, locale)}
                    </span>
                    <span className={`mt-0.5 block text-[13px] font-medium ${product.inStock ? 'text-success' : 'text-destructive'}`}>
                      {product.inStock ? t('search.available') : t('search.outOfStock')}
                    </span>
                  </span>
                </button>

                {product.hasVariants ? (
                  <button
                    type="button"
                    onClick={() => setPreview(product)}
                    aria-label={`${t('store.chooseShort')}: ${product.name}`}
                    className="min-h-11 shrink-0 rounded-xl border border-border-strong px-3 text-sm font-semibold text-primary transition-colors hover:bg-surface-raised"
                  >
                    {t('store.chooseShort')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => add(product, event.currentTarget)}
                    disabled={!product.inStock}
                    aria-label={`${t('store.addShort')}: ${product.name}`}
                    className="min-h-11 shrink-0 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium text-primary transition-colors hover:border-brand hover:bg-surface-raised active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('store.addShort')}
                  </button>
                )}
              </li>
              ))}
            </ul>
          </div>
        )}

        {results.metadata.total > results.products.length && (
          <p className="pt-3 text-xs text-muted">
            {t('search.showing', { shown: results.products.length, total: results.metadata.total })}
          </p>
        )}
      </section>

      {/* Tiendas: grilla estática. Menos de 15 tiendas no justifican un carrusel. */}
      <section aria-label={t('search.storesSection')} className="mt-12">
        <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {location ? t('search.storesNearby') : t('search.storesAll')}
          </h2>
          {results.stores.length > 0 && (
            <span
              aria-live="polite"
              className="inline-flex w-fit items-center rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-secondary tabular-nums"
            >
              {t(
                results.stores.length === 1 ? 'search.storeCountOne' : 'search.storeCountMany',
                { count: results.stores.length },
              )}
            </span>
          )}
        </div>

        {results.stores.length === 0 ? (
          <EmptyState
            compact
            icon={Store}
            title={t('search.noStoresTitle')}
            description={t('search.noStores')}
            action={
              location ? (
                <button type="button" onClick={clearLocation} className="btn-secondary text-sm">
                  {t('search.clearLocation')}
                </button>
              ) : undefined
            }
            className="mt-3"
          />
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {results.stores.map((store) => (
              <li key={store.id} className="min-w-0">
                <Link
                  href={`/${store.slug}`}
                  className="flex h-full flex-col rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-raised"
                >
                  <span className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-raised text-base font-semibold text-secondary">
                      {store.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- logo remoto del comercio
                        <img src={store.logoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        store.name.slice(0, 1).toUpperCase()
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold leading-tight">
                        {store.name}
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-tertiary">
                        {store.category ?? t('search.merchantFallback')}
                      </span>
                    </span>
                  </span>

                  <span className="mt-3 flex items-center justify-between text-[13px] text-tertiary">
                    <span className="tabular-nums">
                      {t('search.storeAvailable', { count: store.inStockCount })}
                    </span>
                    {store.distanceKm !== null && (
                      <span className="tabular-nums">
                        {formatDistanceKm(store.distanceKm, locale)}
                      </span>
                    )}
                  </span>
                  {store.district && (
                    <span className="mt-1 block truncate text-sm text-muted">
                      {store.district}
                    </span>
                  )}
                  <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-secondary">
                    {t('home.previewVisitStore')}
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Vista previa del producto */}
      {preview && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/65 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-preview-title"
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-border bg-surface sm:max-w-lg sm:rounded-3xl"
          >
            <div className="relative">
              {preview.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- imagen cargada por el comercio
                <img
                  src={preview.imageUrl}
                  alt={preview.name}
                  className="h-48 w-full object-cover sm:h-56"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-36 w-full items-center justify-center bg-surface-raised text-4xl font-semibold text-tertiary sm:h-44"
                >
                  {preview.name.slice(0, 1).toUpperCase()}
                </div>
              )}
              <button
                ref={closePreviewRef}
                type="button"
                onClick={() => setPreview(null)}
                aria-label={t('cart.closeConfirm')}
                className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-background/85 text-xl text-primary backdrop-blur hover:bg-background"
              >
                ×
              </button>
              {previewInCart > 0 && (
                <span className="absolute left-3 top-3 rounded-full bg-success px-3 py-1 text-xs font-semibold text-background">
                  {t('home.previewInCart', { count: previewInCart })}
                </span>
              )}
            </div>

            <div className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="home-preview-title" className="text-2xl font-semibold leading-tight tracking-tight">
                    {preview.name}
                  </h2>
                  <Link
                    href={`/${preview.storeSlug}`}
                    className="group mt-2 inline-flex max-w-full items-center gap-2 rounded-xl border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium text-primary transition-colors hover:border-brand hover:bg-surface"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background text-secondary">
                      <Store className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="truncate">{preview.storeName}</span>
                    <span className="shrink-0 text-tertiary" aria-hidden="true">
                      ·
                    </span>
                    <span className="shrink-0 font-semibold underline decoration-border underline-offset-4 group-hover:decoration-brand">
                      {t('home.previewVisitStore')}
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </Link>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-2xl font-semibold tabular-nums">
                    {preview.hasVariants && (
                      <span className="mr-1 text-[10px] font-normal text-muted">{t('store.from')}</span>
                    )}
                    {formatPriceCents(preview.priceCents, preview.currency, locale)}
                  </div>
                  <div
                    className={`mt-1 text-sm font-medium ${
                      preview.inStock ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {preview.inStock
                      ? t('store.available', { count: preview.available })
                      : t('search.outOfStock')}
                  </div>
                </div>
              </div>

              {preview.description && (
                <p className="mt-4 whitespace-pre-line text-body leading-relaxed text-secondary">
                  {preview.description}
                </p>
              )}

              {preview.hasVariants && (
                <p className="mt-4 rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-secondary">
                  {t('home.previewVariants', { count: preview.variantCount })}
                </p>
              )}

              <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-background px-4 py-3">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="mt-0.5 h-4 w-4 shrink-0 text-tertiary"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[1.5px] text-muted">
                    {t('home.previewPickup')}
                  </p>
                  <p className="mt-0.5 text-sm text-secondary">
                    {previewAddress || t('home.previewNoAddress')}
                  </p>
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                {preview.hasVariants ? (
                  <Link
                    href={`/${preview.storeSlug}/p/${preview.productSlug}`}
                    className="flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-body font-semibold text-background hover:opacity-90"
                  >
                    {t('home.previewChoose')}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => add(preview, event.currentTarget)}
                    disabled={!preview.inStock}
                    className="min-h-12 flex-1 rounded-xl bg-brand px-4 text-body font-semibold text-background transition-transform hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {preview.inStock
                      ? previewInCart > 0
                        ? t('home.previewAddAnother')
                        : t('product.addToCart')
                      : t('search.outOfStock')}
                  </button>
                )}
                <Link
                  href="/cart"
                  className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-border-strong px-4 text-body font-medium hover:bg-surface-raised"
                >
                  {t('product.viewCart')}
                  {cartCount > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-background">
                      {cartCount}
                    </span>
                  )}
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {cartConflict && (
        <div
          className="fixed inset-0 z-[110] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCartConflict(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-cart-conflict-title"
            className="w-full max-w-md rounded-t-3xl border border-border bg-surface p-6 sm:rounded-3xl"
          >
            <h2 id="home-cart-conflict-title" className="text-xl font-semibold">
              {t('product.conflictTitle')}
            </h2>
            <p className="mt-2 text-body text-secondary">
              {t('product.conflictBody', {
                current: cartConflict.conflict.current.storeName ?? t('product.otherStore'),
                next: cartConflict.conflict.next.storeName ?? t('product.thisStore'),
              })}
            </p>
            <p className="mt-2 text-sm text-tertiary">{t('product.conflictNote')}</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                onClick={confirmSwitch}
                className="h-12 rounded-xl bg-brand px-4 text-body font-semibold text-background hover:opacity-90"
              >
                {t('product.switchStore')}
              </button>
              <button
                ref={keepCartRef}
                type="button"
                onClick={() => setCartConflict(null)}
                className="h-12 rounded-xl border border-border-strong px-4 text-body font-medium hover:bg-surface-raised"
              >
                {t('product.keepCart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CTA comercios */}
      <section className="my-10 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <p className="text-xs uppercase tracking-[2px] text-muted">{t('home.businessKicker')}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">{t('home.businessTitle')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-secondary">{t('home.businessBody')}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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
          {businessWhatsAppUrl && (
            <a
              href={businessWhatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-success/40 bg-success/10 px-5 text-sm font-semibold text-success transition-colors hover:bg-success/15"
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              {t('home.businessWhatsApp')}
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
