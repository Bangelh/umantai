'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useCartStore, type CartConflict } from '@/lib/cartStore';
import type { Product } from '@/lib/products';
import {
  variantKeyFromOptionValues,
  type CatalogVariant,
  type ProductOptionSchema,
} from '@/lib/catalog';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/components/i18n/I18nProvider';

interface Props {
  product: {
    storeId: string;
    slug: string;
    name: string;
    brand: string;
    price: number;
    category: string;
    description: string;
    imageUrl: string | null;
    available: number;
    unit: string;
    currency: string;
    storeSlug: string;
    storeName: string;
    optionSchema: ProductOptionSchema[];
    variants: CatalogVariant[];
  };
}

export function StoreProductActions({ product }: Props) {
  const { locale, t } = useI18n();
  const addItem = useCartStore((state) => state.addItem);
  const switchStore = useCartStore((state) => state.switchStore);
  const hasVariants = product.variants.length > 0;

  const firstVariant = useMemo(
    () => product.variants.find((variant) => variant.inStock) ?? product.variants[0] ?? null,
    [product.variants],
  );
  const [selected, setSelected] = useState<Record<string, string>>(
    firstVariant ? { ...firstVariant.optionValues } : {},
  );
  const [quantity, setQuantity] = useState(1);
  const [conflict, setConflict] = useState<CartConflict | null>(null);

  const selectedKey = variantKeyFromOptionValues(selected);
  const selectedVariant = hasVariants
    ? product.variants.find((variant) => variant.variantKey === selectedKey) ?? null
    : null;
  const price = selectedVariant?.priceCents ?? product.price;
  const available = selectedVariant ? selectedVariant.available : product.available;
  const disabled = !hasVariants ? product.available <= 0 : !selectedVariant || !selectedVariant.inStock;
  const max = Math.max(1, Math.min(available, 99));

  const handleAdd = () => {
    if (disabled) return;
    if (hasVariants && !selectedVariant) {
      toast.error(t('product.chooseCombination'));
      return;
    }

    // Snapshot de presentación. El checkout vuelve a resolver tienda, variante,
    // precio y stock contra la base.
    const cartProduct: Product = {
      slug: product.slug,
      name: product.name,
      brand: product.brand,
      price,
      category: product.category,
      description: product.description,
      specs: [],
      inStock: available,
      rating: 0,
      reviewCount: 0,
      images: product.imageUrl ? [product.imageUrl] : [],
      storeId: product.storeId,
      storeSlug: product.storeSlug,
      storeName: product.storeName,
    };

    const result = addItem(cartProduct, quantity, selectedVariant ? selected : undefined);
    if (result.status === 'conflict') {
      setConflict(result);
      return;
    }
    toast.success(t('product.added', { quantity, name: product.name }));
  };

  const confirmSwitch = () => {
    if (!conflict) return;
    const cartProduct: Product = {
      slug: product.slug,
      name: product.name,
      brand: product.brand,
      price,
      category: product.category,
      description: product.description,
      specs: [],
      inStock: available,
      rating: 0,
      reviewCount: 0,
      images: product.imageUrl ? [product.imageUrl] : [],
      storeId: product.storeId,
      storeSlug: product.storeSlug,
      storeName: product.storeName,
    };
    switchStore(cartProduct, quantity, selectedVariant ? selected : undefined);
    setConflict(null);
    toast.success(t('product.switched', { store: product.storeName }));
  };

  return (
    <>
      <section className="mt-6 flex flex-col gap-3 border-t border-border pt-5">
        {hasVariants && (
          <div className="flex flex-wrap items-end gap-3">
            {product.optionSchema.map((axis) => (
              <label key={axis.name} className="text-xs uppercase tracking-[1.5px] text-muted">
                {axis.name}
                <select
                  value={selected[axis.name] ?? ''}
                  onChange={(event) => {
                    setSelected((current) => ({ ...current, [axis.name]: event.target.value }));
                    setQuantity(1);
                  }}
                  className="mt-1 block h-10 rounded-xl border border-border-strong bg-background px-3 text-sm normal-case tracking-normal text-primary"
                >
                  <option value="">{t('product.chooseAxis', { axis: axis.name })}</option>
                  {axis.values.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatMoney(price, product.currency, locale)}
            </div>
            <div className={`mt-0.5 text-xs font-medium ${disabled ? 'text-destructive' : 'text-success'}`}>
              {disabled
                ? selectedVariant
                  ? t('product.combinationOut')
                  : hasVariants
                    ? t('product.chooseOption')
                    : t('product.outOfStock')
                : selectedVariant
                  ? t('product.availableSku', { count: available, sku: selectedVariant.sku })
                  : t('product.inStock', { count: available })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="store-product-qty" className="text-xs uppercase tracking-[1.5px] text-muted">
              {t('product.quantity')}
            </label>
            <div className="flex items-center rounded-xl border border-border-strong">
              <button
                type="button"
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                disabled={quantity <= 1 || disabled}
                aria-label={t('product.decrease')}
                className="h-11 w-11 text-lg disabled:opacity-40"
              >
                −
              </button>
              <input
                id="store-product-qty"
                value={quantity}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) {
                    setQuantity(Math.min(max, Math.max(1, Math.round(parsed))));
                  }
                }}
                inputMode="numeric"
                aria-label={t('product.quantity')}
                className="h-11 w-12 border-x border-border bg-transparent text-center font-mono tabular-nums"
              />
              <button
                type="button"
                onClick={() => setQuantity((value) => Math.min(max, value + 1))}
                disabled={quantity >= max || disabled}
                aria-label={t('product.increase')}
                className="h-11 w-11 text-lg disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={handleAdd}
            disabled={disabled}
            className="h-12 flex-1 rounded-xl bg-brand px-6 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {disabled ? t('product.unavailable') : t('product.addToCart')}
          </button>
          <Link
            href="/cart"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-border-strong px-5 text-sm font-medium hover:bg-surface-raised"
          >
            {t('product.viewCart')}
          </Link>
        </div>
      </section>

      {conflict && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConflict(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cart-store-conflict-title"
            className="w-full max-w-md rounded-t-3xl border border-border bg-surface p-6 sm:rounded-3xl"
          >
            <h2 id="cart-store-conflict-title" className="text-lg font-semibold">
              {t('product.conflictTitle')}
            </h2>
            <p className="mt-2 text-sm text-secondary">
              {t('product.conflictBody', {
                current: conflict.current.storeName ?? t('product.otherStore'),
                next: conflict.next.storeName ?? t('product.thisStore'),
              })}
            </p>
            <p className="mt-2 text-xs text-muted">{t('product.conflictNote')}</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                onClick={confirmSwitch}
                className="h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-background hover:opacity-90"
              >
                {t('product.switchStore')}
              </button>
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="h-11 rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
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
