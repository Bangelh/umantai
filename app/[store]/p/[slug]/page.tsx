/**
 * /<store-slug>/p/<product-slug> — detalle de un producto de tienda.
 *
 * La búsqueda no muestra fotos; el detalle sí puede usarlas si el comercio las
 * cargó. La acción principal es agregar al carrito.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StoreProductActions } from './StoreProductActions';
import { getStoreProductDetail } from '@/lib/stores.server';
import { validateStoreSlug } from '@/lib/tenancy';
import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ store: string; slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { store, slug } = await params;
  const { t } = await getTranslator();
  const slugCheck = validateStoreSlug(store);
  if (!slugCheck.ok) return { title: t('product.notFound'), robots: { index: false, follow: false } };

  const detail = await getStoreProductDetail(slugCheck.slug, slug);
  if (!detail) return { title: t('product.notFound'), robots: { index: false, follow: false } };

  return {
    title: `${detail.product.name} · ${detail.store.name}`,
    description:
      detail.product.description ??
      `${detail.product.name} · ${detail.store.name} · UMANTAI`,
    alternates: { canonical: `/${detail.store.slug}/p/${detail.product.slug}` },
    openGraph: { type: 'website', title: detail.product.name },
  };
}

export default async function StoreProductPage({ params }: PageProps) {
  const { t } = await getTranslator();
  const { store, slug } = await params;
  const slugCheck = validateStoreSlug(store);
  if (!slugCheck.ok) notFound();

  const detail = await getStoreProductDetail(slugCheck.slug, slug);
  if (!detail) notFound();

  const { store: shop, product } = detail;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 sm:px-6">
      <nav aria-label={t('product.breadcrumb')} className="pt-4 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">UMANTAI</Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/${shop.slug}`} className="hover:text-primary">{shop.name}</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{product.name}</span>
      </nav>

      {/* El precio y el stock NO se repiten acá: el bloque de compra es el único
          que los muestra (y los actualiza al cambiar de variante). Antes había dos
          precios en pantalla y el de arriba no reaccionaba a la variante. */}
      <header className="mt-5 flex items-start gap-4 border-b border-border pb-5">
        {product.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- imagen cargada por el comercio
          <img
            src={product.imageUrl}
            alt={product.name}
            className="h-24 w-24 shrink-0 rounded-2xl border border-border object-cover sm:h-28 sm:w-28"
          />
        )}
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[2px] text-tertiary">
            {product.category ?? shop.category ?? t('product.fallbackCategory')}
          </p>
          <h1 className="mt-1 text-[1.75rem] font-semibold leading-tight tracking-tight sm:text-4xl">
            {product.name}
          </h1>
          <p className="mt-2 text-body text-secondary">
            <Link
              href={`/${shop.slug}`}
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              {shop.name}
            </Link>
            {product.brand && <span className="text-tertiary"> · {product.brand}</span>}
          </p>
        </div>
      </header>

      {product.description && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-primary">{t('product.description')}</h2>
          <p className="mt-2 whitespace-pre-line text-body leading-relaxed text-secondary">
            {product.description}
          </p>
        </section>
      )}

      <StoreProductActions
        product={{
          storeId: shop.id,
          slug: product.slug,
          name: product.name,
          brand: product.brand ?? '',
          // Centavos: la conversión a unidades ocurre UNA vez, al armar la
          // línea del carrito (`centsToUnits`). Antes se mandaba el precio base
          // en unidades y la variante en centavos, y el carrito multiplicaba
          // por 100 cuando había variante.
          priceCents: product.priceCents,
          category: product.category ?? shop.category ?? '',
          description: product.description ?? '',
          imageUrl: product.imageUrl,
          available: product.available,
          unit: product.unit,
          currency: product.currency,
          storeSlug: shop.slug,
          storeName: shop.name,
          optionSchema: product.optionSchema,
          variants: product.variants,
        }}
      />

      <section className="mt-8 rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-body font-semibold">{t('product.pickup')}</h2>
        <p className="mt-1 text-body text-secondary">
          {shop.address
            ? t('product.pickupAt', {
                address: `${shop.address}${shop.district ? `, ${shop.district}` : ''}`,
              })
            : t('product.pickupCoordinate')}
        </p>
        <p className="mt-1 text-sm text-tertiary">{t('product.stockNote')}</p>
      </section>
    </main>
  );
}
