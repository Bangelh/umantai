'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCartStore, type CartConflict } from '@/lib/cartStore';
import {
  variantKeyFromOptionValues,
  type CatalogVariant,
  type ProductOptionSchema,
} from '@/lib/catalog';
import { centsToUnits, formatMoney } from '@/lib/format';
import type { Product } from '@/lib/products';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Catálogo de la vitrina: agregar desde la lista y vista previa.
 *
 * Antes cada fila era un enlace al detalle: para comprar un producto había que
 * entrar, buscar el botón y volver. Ahora la fila abre una vista previa con
 * imagen, nombre, precio y stock, y el botón de la derecha agrega directo.
 *
 * Productos con variantes: el botón abre la vista previa para elegir la
 * combinación; el servidor vuelve a validar variante, precio y stock al crear el
 * pedido, así que esto es solo comodidad, no una fuente de verdad.
 */

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  priceCents: number;
  currency: string;
  unit: string;
  available: number;
  inStock: boolean;
  optionSchema: ProductOptionSchema[];
  variants: CatalogVariant[];
}

interface StoreIdentity {
  id: string;
  slug: string;
  name: string;
}

function basePriceCents(product: CatalogProduct): number {
  if (product.variants.length === 0) return product.priceCents;
  return Math.min(...product.variants.map((variant) => variant.priceCents ?? product.priceCents));
}

export function StoreCatalog({
  store,
  products,
}: {
  store: StoreIdentity;
  products: CatalogProduct[];
}) {
  const { locale, t } = useI18n();
  const addItem = useCartStore((state) => state.addItem);
  const switchStore = useCartStore((state) => state.switchStore);

  const [preview, setPreview] = useState<CatalogProduct | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<
    { conflict: CartConflict; product: CatalogProduct; options?: Record<string, string> } | null
  >(null);
  const keepCartRef = useRef<HTMLButtonElement>(null);

  const hasVariants = (preview?.variants.length ?? 0) > 0;
  const selectedKey = variantKeyFromOptionValues(selected);
  const selectedVariant = hasVariants
    ? preview?.variants.find((variant) => variant.variantKey === selectedKey) ?? null
    : null;

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview]);

  useEffect(() => {
    if (!conflict) return;
    keepCartRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConflict(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [conflict]);

  const openPreview = (product: CatalogProduct) => {
    const first =
      product.variants.find((variant) => variant.inStock) ?? product.variants[0] ?? null;
    setSelected(first ? { ...first.optionValues } : {});
    setPreview(product);
  };

  const snapshot = (product: CatalogProduct, priceCents: number): Product => ({
    slug: product.slug,
    name: product.name,
    brand: product.brand ?? '',
    price: centsToUnits(priceCents),
    category: product.category ?? '',
    description: product.description ?? '',
    specs: [],
    inStock: product.available,
    rating: 0,
    reviewCount: 0,
    images: product.imageUrl ? [product.imageUrl] : [],
    storeId: store.id,
    storeSlug: store.slug,
    storeName: store.name,
  });

  const add = (
    product: CatalogProduct,
    priceCents: number,
    options?: Record<string, string>,
  ) => {
    const result = addItem(snapshot(product, priceCents), 1, options);
    if (result.status === 'conflict') {
      setConflict({ conflict: result, product, options });
      return;
    }
    toast.success(t('product.added', { quantity: 1, name: product.name }));
    setPreview(null);
  };

  const quickAdd = (product: CatalogProduct) => {
    if (product.variants.length > 0) {
      openPreview(product);
      return;
    }
    if (product.available <= 0) return;
    add(product, product.priceCents);
  };

  const confirmSwitch = () => {
    if (!conflict) return;
    const { product, options } = conflict;
    const priceCents = options
      ? product.variants.find(
          (variant) => variant.variantKey === variantKeyFromOptionValues(options),
        )?.priceCents ?? product.priceCents
      : product.priceCents;
    switchStore(snapshot(product, priceCents), 1, options);
    toast.success(t('product.switched', { store: store.name }));
    setConflict(null);
    setPreview(null);
  };

  const modalPriceCents = selectedVariant?.priceCents ?? preview?.priceCents ?? 0;
  const modalAvailable = selectedVariant ? selectedVariant.available : preview?.available ?? 0;
  const modalDisabled = preview
    ? preview.variants.length > 0
      ? !selectedVariant || !selectedVariant.inStock
      : modalAvailable <= 0
    : true;

  const optionAvailable = (axis: string, value: string) => {
    if (!preview) return false;
    const candidate = variantKeyFromOptionValues({ ...selected, [axis]: value });
    return Boolean(preview.variants.find((variant) => variant.variantKey === candidate)?.inStock);
  };

  const optionPrice = (axis: string, value: string) => {
    if (!preview) return null;
    const candidate = variantKeyFromOptionValues({ ...selected, [axis]: value });
    return (
      preview.variants.find((variant) => variant.variantKey === candidate)?.priceCents ?? null
    );
  };

  return (
    <>
      <ul className="divide-y divide-border">
        {products.map((product) => {
          const fromPrice = basePriceCents(product);
          const hasVariantPricing = product.variants.length > 0;

          return (
            <li key={product.id} className="flex items-center gap-3 py-3">
              {product.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- imagen del comercio
                <img
                  src={product.imageUrl}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-xl border border-border object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-raised text-sm font-semibold text-tertiary"
                >
                  {product.name.slice(0, 1).toUpperCase()}
                </div>
              )}

              <button
                type="button"
                onClick={() => openPreview(product)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-[17px] font-medium leading-snug">
                  {product.name}
                </span>
                <span className="mt-0.5 block truncate text-sm text-tertiary">
                  {[product.brand, product.category].filter(Boolean).join(' · ') ||
                    t('store.noBrand')}
                  {product.unit !== 'unidad' && ` · ${t('store.perUnit', { unit: product.unit })}`}
                  {product.variants.length > 0 &&
                    ` · ${t('store.variants', { count: product.variants.length })}`}
                </span>
                <span className="mt-0.5 block text-sm">
                  <span className="font-mono font-semibold tabular-nums">
                    {hasVariantPricing && (
                      <span className="mr-1 text-xs font-normal text-muted">
                        {t('store.from')}
                      </span>
                    )}
                    {formatMoney(fromPrice, product.currency, locale)}
                  </span>
                  <span
                    className={`ml-2 text-[13px] font-medium ${
                      product.inStock ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {product.inStock
                      ? t('store.available', { count: product.available })
                      : t('store.outOfStock')}
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => quickAdd(product)}
                disabled={!product.inStock}
                aria-label={`${t('store.addShort')}: ${product.name}`}
                className="min-h-11 shrink-0 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium text-primary transition-colors hover:border-brand hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
              >
                {product.variants.length > 0
                  ? t('store.chooseShort')
                  : t('store.addShort')}
              </button>
            </li>
          );
        })}
      </ul>

      {preview && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="store-preview-title"
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-border bg-surface p-5 sm:max-w-lg sm:rounded-3xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                {preview.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- imagen del comercio
                  <img
                    src={preview.imageUrl}
                    alt={preview.name}
                    className="h-20 w-20 shrink-0 rounded-2xl border border-border object-cover"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-raised text-xl font-semibold text-tertiary"
                  >
                    {preview.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 id="store-preview-title" className="text-xl font-semibold leading-tight">
                    {preview.name}
                  </h2>
                  <p className="mt-1 text-sm text-tertiary">
                    {[preview.brand, preview.category].filter(Boolean).join(' · ') ||
                      t('store.noBrand')}
                  </p>
                  <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                    {formatMoney(modalPriceCents, preview.currency, locale)}
                  </p>
                  <p
                    className={`text-sm font-medium ${
                      modalAvailable > 0 ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {modalAvailable > 0
                      ? t('store.available', { count: modalAvailable })
                      : t('store.outOfStock')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                aria-label={t('cart.closeConfirm')}
                className="shrink-0 text-2xl text-muted hover:text-primary"
              >
                ×
              </button>
            </div>

            {preview.description && (
              <p className="mt-4 whitespace-pre-line text-body text-secondary">
                {preview.description}
              </p>
            )}

            {hasVariants && (
              <div className="mt-4 space-y-4">
                {preview.optionSchema.map((axis) => (
                  <fieldset key={axis.name} className="min-w-0">
                    <legend className="mb-2 text-body font-semibold">
                      {axis.name.charAt(0).toUpperCase() + axis.name.slice(1)}
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {axis.values.map((value) => {
                        const isSelected = selected[axis.name] === value;
                        const available = optionAvailable(axis.name, value);
                        const price = optionPrice(axis.name, value);
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => setSelected((current) => ({ ...current, [axis.name]: value }))}
                            className={`min-h-11 rounded-xl border px-3 text-sm ${
                              isSelected
                                ? 'border-brand bg-brand font-semibold text-background'
                                : 'border-border-strong hover:bg-surface-raised'
                            } ${!available && !isSelected ? 'opacity-60' : ''}`}
                          >
                            {value}
                            {available && price !== null && price !== preview.priceCents && (
                              <span className={`ml-1 text-xs ${isSelected ? 'opacity-80' : 'text-tertiary'}`}>
                                {formatMoney(price, preview.currency, locale)}
                              </span>
                            )}
                            {!available && (
                              <span className="ml-1 text-xs opacity-70">
                                · {t('product.optionOutOfStock')}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>
            )}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  if (modalDisabled) return;
                  if (preview.variants.length > 0 && !selectedVariant) {
                    toast.error(t('product.chooseCombination'));
                    return;
                  }
                  add(preview, modalPriceCents, selectedVariant ? selected : undefined);
                }}
                disabled={modalDisabled}
                className="min-h-12 flex-1 rounded-xl bg-brand px-4 text-body font-semibold text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {modalDisabled ? t('product.unavailable') : t('product.addToCart')}
              </button>
              <Link
                href={`/${store.slug}/p/${preview.slug}`}
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border-strong px-4 text-body font-medium hover:bg-surface-raised"
              >
                {t('store.viewDetail')}
              </Link>
            </div>
          </div>
        </div>
      )}

      {conflict && (
        <div
          className="fixed inset-0 z-[110] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConflict(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="store-cart-conflict-title"
            className="w-full max-w-md rounded-t-3xl border border-border bg-surface p-6 sm:rounded-3xl"
          >
            <h2 id="store-cart-conflict-title" className="text-xl font-semibold">
              {t('product.conflictTitle')}
            </h2>
            <p className="mt-2 text-body text-secondary">
              {t('product.conflictBody', {
                current: conflict.conflict.current.storeName ?? t('product.otherStore'),
                next: conflict.conflict.next.storeName ?? t('product.thisStore'),
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
                onClick={() => setConflict(null)}
                className="h-12 rounded-xl border border-border-strong px-4 text-body font-medium hover:bg-surface-raised"
              >
                {t('product.keepCart')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
