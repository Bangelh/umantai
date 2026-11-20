/**
 * /<store-slug> — vitrina pública de un comercio.
 *
 * Ruta dinámica de primer nivel. Las rutas estáticas existentes (`/products`,
 * `/cart`, `/legal`, `/admin`…) tienen prioridad sobre este segmento, y además
 * los slugs reservados se rechazan al crear la tienda y al resolverla acá.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Package, Search } from 'lucide-react';
import { AuroraBackdrop } from '@/components/ui/AuroraBackdrop';
import { EmptyState } from '@/components/ui/EmptyState';
import { SpotlightSurface } from '@/components/ui/SpotlightSurface';
import { StoreCatalog } from './StoreCatalog';
import { StoreFooter } from './StoreFooter';
import { StoreSearch } from './StoreSearch';
import { normalizeSearchText } from '@/lib/catalog';
import {
  getStorefront,
  getStoreHoursBySlug,
  getStorePaymentInfoBySlug,
} from '@/lib/stores.server';
import { isOnlinePaymentEnabled } from '@/lib/online-payments';
import { validateStoreSlug } from '@/lib/tenancy';
import { getTranslator } from '@/lib/i18n/server';
import { whatsappUrl } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ store: string }>;
  searchParams: Promise<{ q?: string | string[]; category?: string | string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { store: storeSlug } = await params;
  const slugCheck = validateStoreSlug(storeSlug);
  if (!slugCheck.ok) return { title: 'Tienda no encontrada' };

  const storefront = await getStorefront(slugCheck.slug);
  if (!storefront) return { title: 'Tienda no encontrada' };

  const { store } = storefront;
  return {
    title: store.name,
    description:
      store.description ??
      `Catálogo de ${store.name}${store.category ? ` (${store.category})` : ''} en UMANTAI.`,
    alternates: { canonical: `/${store.slug}` },
    // Una tienda inactiva no debe indexarse aunque alguien conozca la URL.
    robots: store.active ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      title: `${store.name} | UMANTAI`,
      description: store.description ?? undefined,
      type: 'website',
      url: `/${store.slug}`,
    },
  };
}

export default async function StorePage({ params, searchParams }: PageProps) {
  const { t } = await getTranslator();
  const { store: storeSlug } = await params;
  const slugCheck = validateStoreSlug(storeSlug);
  if (!slugCheck.ok) notFound();

  const storefront = await getStorefront(slugCheck.slug);
  if (!storefront) notFound();

  const { store } = storefront;
  const payments = await getStorePaymentInfoBySlug(store.slug);
  const hours = await getStoreHoursBySlug(store.slug);
  const { q: rawQuery, category: rawCategory } = await searchParams;
  const queryText = (Array.isArray(rawQuery) ? rawQuery[0] : rawQuery) ?? '';
  const query = normalizeSearchText(queryText);
  const allProducts = storefront.products;
  const categories = [
    ...new Set(
      allProducts
        .map((product) => product.category)
        .filter((category): category is string => Boolean(category)),
    ),
  ].sort((a, b) => a.localeCompare(b, 'es'));
  const categorySummary = categories.map((category) => ({
    name: category,
    count: allProducts.filter((product) => product.category === category).length,
  }));

  const rawCategoryText = (
    (Array.isArray(rawCategory) ? rawCategory[0] : rawCategory) ?? ''
  ).trim();
  const categoryFilter =
    categories.find(
      (category) => category.toLocaleLowerCase('es') === rawCategoryText.toLocaleLowerCase('es'),
    ) ?? '';

  const products = allProducts.filter((product) => {
    if (categoryFilter && product.category !== categoryFilter) return false;
    if (!query) return true;
    return normalizeSearchText(
      [product.name, product.brand, product.category, product.description]
        .filter(Boolean)
        .join(' '),
    ).includes(query);
  });
  const availableCount = products.filter((product) => product.inStock).length;
  const hasFilter = Boolean(query || categoryFilter);
  const buildHref = (next: { q?: string; category?: string }): string => {
    const params = new URLSearchParams();
    if (next.q?.trim()) params.set('q', next.q.trim());
    if (next.category) params.set('category', next.category);
    const suffix = params.toString();
    return `/${store.slug}${suffix ? `?${suffix}` : ''}`;
  };

  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 sm:px-6">
      {/* Cabecera de la vitrina: misma atmósfera que el home, contenida al
          bloque de identidad para no competir con el catálogo. */}
      <div className="relative isolate -mx-4 px-4 pb-1 sm:-mx-6 sm:px-6">
        <AuroraBackdrop />
      <nav aria-label={t('store.breadcrumb')} className="relative pt-4 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          UMANTAI
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{store.name}</span>
      </nav>

      <SpotlightSurface
        className="surface-card relative mt-4"
        bodyClassName="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:p-5"
      >
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface-raised text-xl font-semibold text-secondary">
            {store.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- logo remoto del comercio
              <img src={store.logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              store.name.slice(0, 1).toUpperCase()
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[2px] text-muted">
              {t('store.catalog')}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{store.name}</h1>
            <p className="mt-1 text-body text-secondary">
              {[store.category, store.district, store.city].filter(Boolean).join(' · ') || t('store.commerce')}
            </p>
            {store.address && <p className="mt-1 text-sm text-tertiary">{store.address}</p>}
            {store.description && <p className="mt-2 max-w-2xl text-body text-secondary">{store.description}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs sm:hidden">
              <span className="rounded-full border border-border bg-surface-raised px-2.5 py-1 font-medium text-secondary tabular-nums">
                {t(
                  products.length === 1 ? 'search.productCountOne' : 'search.productCountMany',
                  { count: products.length },
                )}
              </span>
              <span className="rounded-full border border-success/40 bg-success/10 px-2.5 py-1 font-medium text-success tabular-nums">
                {t('store.available', { count: availableCount })}
              </span>
            </div>
          </div>
        </div>

        <div className="hidden shrink-0 text-right sm:block">
          <div className="text-xs uppercase tracking-[1.5px] text-muted">{t('store.products')}</div>
          <div className="font-mono text-2xl font-semibold tabular-nums">{products.length}</div>
          <div className="text-xs text-success tabular-nums">
            {t('store.available', { count: availableCount })}
          </div>
        </div>
      </SpotlightSurface>
      </div>

      {store.whatsapp && (
        <div className="mt-3">
          <a
            href={whatsappUrl(store.whatsapp, t('store.whatsappMessage', { store: store.name })) ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
          >
            {t('store.whatsapp')}
          </a>
        </div>
      )}

      <section aria-label={t('store.products')} className="mt-5">
        <div className="sticky top-20 z-30 -mx-4 mb-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
          <StoreSearch
            storeSlug={store.slug}
            storeName={store.name}
            initialQuery={queryText}
            category={categoryFilter}
            suggestions={allProducts.map((product) => ({
              name: product.name,
              category: product.category,
            }))}
          />
        </div>

        {categories.length > 1 && (
          <div
            role="group"
            aria-label={t('store.filterByCategory')}
            className="mb-4 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]"
          >
            <Link
              href={buildHref({ q: queryText })}
              aria-current={!categoryFilter ? 'page' : undefined}
              className={`inline-flex min-h-10 shrink-0 items-center rounded-full border px-3 text-sm transition-colors ${
                !categoryFilter
                  ? 'border-brand bg-brand font-medium text-background'
                  : 'border-border text-secondary hover:border-border-strong'
              }`}
            >
              {t('store.allCategories')}
            </Link>
            {categories.map((category) => (
              <Link
                key={category}
                href={buildHref({ q: queryText, category })}
                aria-current={categoryFilter === category ? 'page' : undefined}
                className={`inline-flex min-h-10 shrink-0 items-center rounded-full border px-3 text-sm transition-colors ${
                  categoryFilter === category
                    ? 'border-brand bg-brand font-medium text-background'
                    : 'border-border text-secondary hover:border-border-strong'
                }`}
              >
                {category}
              </Link>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border pb-3">
          <h2 className="text-lg font-semibold tracking-tight sm:text-xl">
            {t('store.products')}
          </h2>
          <span className="text-sm text-tertiary tabular-nums">
            {t(products.length === 1 ? 'search.productCountOne' : 'search.productCountMany', {
              count: products.length,
            })}
            {' · '}
            {t('store.available', { count: availableCount })}
          </span>
        </div>

        {products.length === 0 ? (
          <EmptyState
            align="center"
            icon={hasFilter ? Search : Package}
            title={hasFilter ? t('store.noResultsTitle') : t('store.emptyTitle')}
            description={
              query
                ? t('store.noResults', { query: queryText.trim() })
                : categoryFilter
                  ? t('store.noCategoryResults', { category: categoryFilter })
                  : t('store.empty')
            }
            action={
              <Link href={hasFilter ? `/${store.slug}` : '/'} className="btn-secondary text-sm">
                {hasFilter ? t('store.viewAll') : t('store.backToSearch')}
              </Link>
            }
            className="mt-4"
          />
        ) : (
          <StoreCatalog store={{ id: store.id, slug: store.slug, name: store.name }} products={products} />
        )}
      </section>

      <StoreFooter
        store={store}
        payments={payments}
        categories={categorySummary}
        hours={hours}
        cardPaymentsEnabled={isOnlinePaymentEnabled()}
      />
    </main>
  );
}
