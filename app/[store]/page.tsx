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
import { BrandLogo } from '@/components/brand/BrandLogo';
import { EmptyState } from '@/components/ui/EmptyState';
import { StoreCatalog } from './StoreCatalog';
import { normalizeSearchText } from '@/lib/catalog';
import { getStorefront } from '@/lib/stores.server';
import { validateStoreSlug } from '@/lib/tenancy';
import { getTranslator } from '@/lib/i18n/server';
import { whatsappUrl } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ store: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
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
  const rawQuery = (await searchParams).q;
  const query = normalizeSearchText(Array.isArray(rawQuery) ? rawQuery[0] : rawQuery ?? '');
  const products = query
    ? storefront.products.filter((product) =>
        normalizeSearchText(
          [product.name, product.brand, product.category, product.description]
            .filter(Boolean)
            .join(' '),
        ).includes(query),
      )
    : storefront.products;
  const availableCount = products.filter((product) => product.inStock).length;

  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 sm:px-6">
      <nav aria-label={t('store.breadcrumb')} className="pt-4 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          UMANTAI
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{store.name}</span>
      </nav>

      <header className="mt-4 flex items-start gap-4 border-b border-border pb-5">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface-raised text-xl font-semibold text-secondary">
          {store.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo remoto del comercio
            <img src={store.logoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            store.name.slice(0, 1).toUpperCase()
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{store.name}</h1>
          <p className="mt-1 text-body text-secondary">
            {[store.category, store.district, store.city].filter(Boolean).join(' · ') || t('store.commerce')}
          </p>
          {store.address && <p className="mt-1 text-sm text-tertiary">{store.address}</p>}
          {store.description && <p className="mt-2 max-w-2xl text-body text-secondary">{store.description}</p>}
        </div>

        <div className="hidden shrink-0 text-right sm:block">
          <div className="text-xs uppercase tracking-[1.5px] text-muted">{t('store.catalog')}</div>
          <div className="font-mono text-2xl font-semibold tabular-nums">{products.length}</div>
          <div className="text-xs text-success tabular-nums">
            {t('store.available', { count: availableCount })}
          </div>
        </div>
      </header>

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
        <form action={`/${store.slug}`} method="get" role="search" className="mb-4 flex gap-2">
          <label htmlFor="store-search" className="sr-only">
            {t('store.searchLabel', { store: store.name })}
          </label>
          <input
            id="store-search"
            type="search"
            name="q"
            defaultValue={rawQuery && !Array.isArray(rawQuery) ? rawQuery : ''}
            placeholder={t('store.searchPlaceholder', { store: store.name })}
            maxLength={80}
            className="h-12 min-w-0 flex-1 rounded-xl border border-border-strong bg-background px-3 text-body"
          />
          <button
            type="submit"
            className="h-12 rounded-xl border border-border-strong px-4 text-base font-medium hover:bg-surface-raised"
          >
            {t('store.search')}
          </button>
          {query && (
            <Link
              href={`/${store.slug}`}
              className="inline-flex h-12 items-center rounded-xl px-2 text-sm text-tertiary hover:text-primary"
            >
              {t('store.clear')}
            </Link>
          )}
        </form>

        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-base font-semibold text-secondary">
            {t('store.products')}
          </h2>
          <span className="text-sm text-tertiary sm:hidden">
            {products.length} · {t('store.available', { count: availableCount })}
          </span>
        </div>

        {products.length === 0 ? (
          <EmptyState
            align="center"
            icon={query ? Search : Package}
            title={query ? t('store.noResultsTitle') : t('store.emptyTitle')}
            description={query ? t('store.noResults', { query }) : t('store.empty')}
            action={
              <Link href={query ? `/${store.slug}` : '/'} className="btn-secondary text-sm">
                {query ? t('store.viewAll') : t('store.backToSearch')}
              </Link>
            }
            className="mt-4"
          />
        ) : (
          <StoreCatalog store={{ id: store.id, slug: store.slug, name: store.name }} products={products} />
        )}
      </section>

      <footer className="mt-10 border-t border-border pt-5 text-sm text-tertiary">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{t('store.soldBy', { store: store.name })}</span>
          <Link href="/vender" className="hover:text-primary">
            {t('store.sellCta')}
          </Link>
        </div>
        <div className="mt-4 opacity-60">
          <BrandLogo size="sm" />
        </div>
      </footer>
    </main>
  );
}
