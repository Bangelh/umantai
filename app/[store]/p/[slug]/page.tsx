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
import { formatPriceCents } from '@/lib/discovery';
import { getStoreProductDetail } from '@/lib/stores.server';
import { validateStoreSlug } from '@/lib/tenancy';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ store: string; slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { store, slug } = await params;
  const slugCheck = validateStoreSlug(store);
  if (!slugCheck.ok) return { title: 'Producto no encontrado' };

  const detail = await getStoreProductDetail(slugCheck.slug, slug);
  if (!detail) return { title: 'Producto no encontrado' };

  return {
    title: `${detail.product.name} · ${detail.store.name}`,
    description:
      detail.product.description ??
      `${detail.product.name} en ${detail.store.name}, disponible en UMANTAI.`,
    alternates: { canonical: `/${detail.store.slug}/p/${detail.product.slug}` },
  };
}

export default async function StoreProductPage({ params }: PageProps) {
  const { store, slug } = await params;
  const slugCheck = validateStoreSlug(store);
  if (!slugCheck.ok) notFound();

  const detail = await getStoreProductDetail(slugCheck.slug, slug);
  if (!detail) notFound();

  const { store: shop, product } = detail;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 sm:px-6">
      <nav aria-label="Migas de pan" className="pt-4 text-xs text-muted">
        <Link href="/" className="hover:text-primary">UMANTAI</Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/${shop.slug}`} className="hover:text-primary">{shop.name}</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{product.name}</span>
      </nav>

      <header className="mt-5 border-b border-border pb-5">
        <p className="text-xs uppercase tracking-[2px] text-muted">{product.category ?? shop.category ?? 'Producto'}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{product.name}</h1>
        <p className="mt-1 text-sm text-tertiary">
          <Link href={`/${shop.slug}`} className="underline-offset-2 hover:text-primary hover:underline">
            {shop.name}
          </Link>
          {product.brand && ` · ${product.brand}`}
        </p>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <div className="font-mono text-3xl font-semibold tabular-nums">
              {formatPriceCents(product.priceCents, product.currency)}
            </div>
            <div className={`mt-1 text-sm font-medium ${product.inStock ? 'text-success' : 'text-destructive'}`}>
              {product.inStock ? `${product.available} disponibles` : 'Agotado'}
            </div>
          </div>
          {product.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- imagen cargada por el comercio
            <img
              src={product.imageUrl}
              alt={product.name}
              className="h-20 w-20 rounded-xl border border-border object-cover"
            />
          )}
        </div>
      </header>

      {product.description && (
        <section className="mt-5">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Descripción</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-secondary">{product.description}</p>
        </section>
      )}

      <StoreProductActions
        product={{
          storeId: shop.id,
          slug: product.slug,
          name: product.name,
          brand: product.brand ?? '',
          price: product.priceCents / 100,
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
        <h2 className="text-sm font-semibold">Retiro</h2>
        <p className="mt-1 text-sm text-secondary">
          {shop.address
            ? `Retira en ${shop.address}${shop.district ? `, ${shop.district}` : ''}.`
            : 'Coordina el retiro con el comercio al confirmar tu pedido.'}
        </p>
        <p className="mt-1 text-xs text-muted">El stock se reserva recién cuando confirmas la compra.</p>
      </section>
    </main>
  );
}
