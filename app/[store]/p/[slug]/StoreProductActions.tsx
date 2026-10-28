'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCartStore, type CartConflict } from '@/lib/cartStore';
import type { Product } from '@/lib/products';
import {
  variantKeyFromOptionValues,
  type CatalogVariant,
  type ProductOptionSchema,
} from '@/lib/catalog';
import { centsToUnits, formatMoney } from '@/lib/format';
import { useI18n } from '@/components/i18n/I18nProvider';

interface Props {
  product: {
    storeId: string;
    slug: string;
    name: string;
    brand: string;
    /** Precio base en CENTAVOS (contrato: ver cabecera de `lib/format.ts`). */
    priceCents: number;
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

/**
 * Nombre visible de un eje de variación.
 *
 * El eje lo escribe el comerciante en minúsculas y sin tilde (`presentacion`,
 * `talla`). Los ejes conocidos tienen etiqueta propia —con tilde y en el idioma
 * de la página—; uno nuevo cae al nombre capitalizado, que es lo único honesto
 * que se puede hacer sin inventar datos.
 */
const AXIS_LABELS: Record<string, { es: string; en: string }> = {
  presentacion: { es: 'Presentación', en: 'Pack size' },
  presentación: { es: 'Presentación', en: 'Pack size' },
  tamano: { es: 'Tamaño', en: 'Size' },
  tamaño: { es: 'Tamaño', en: 'Size' },
  talla: { es: 'Talla', en: 'Size' },
  color: { es: 'Color', en: 'Color' },
  peso: { es: 'Peso', en: 'Weight' },
  capacidad: { es: 'Capacidad', en: 'Capacity' },
  medida: { es: 'Medida', en: 'Measurement' },
  sabor: { es: 'Sabor', en: 'Flavor' },
  material: { es: 'Material', en: 'Material' },
};

function axisLabel(name: string, locale: 'es' | 'en'): string {
  const known = AXIS_LABELS[name.trim().toLowerCase()];
  if (known) return known[locale];
  const capitalized = name.trim();
  return capitalized.charAt(0).toUpperCase() + capitalized.slice(1);
}

/**
 * Bloque de compra del detalle de producto.
 *
 * ── JERARQUÍA (de arriba a abajo, en el orden en que el comprador decide) ─────
 *   1. Cuánto cuesta (grande, se actualiza al elegir variante)
 *   2. Cuánto queda
 *   3. Qué variante quiere (botones, no un `<select>` escondido)
 *   4. Cuántas unidades
 *   5. Agregar al carrito (una sola acción primaria)
 *
 * No se muestra el SKU ni ninguna metadata interna: el comprador no la necesita y
 * antes aparecía mezclada con la disponibilidad.
 */
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
  const keepCartRef = useRef<HTMLButtonElement>(null);

  // El aviso de otra tienda es modal: lleva el foco a la opción segura y se
  // cierra con Escape, igual que el resto de diálogos de la tienda.
  useEffect(() => {
    if (!conflict) return;
    keepCartRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConflict(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [conflict]);

  const selectedKey = variantKeyFromOptionValues(selected);
  const selectedVariant = hasVariants
    ? product.variants.find((variant) => variant.variantKey === selectedKey) ?? null
    : null;
  // El precio efectivo SIEMPRE está en centavos, venga de la variante o de la
  // base. La UI lo formatea con `formatMoney` (centavos) y el carrito lo recibe
  // en unidades tras una única conversión explícita.
  const priceCents = selectedVariant?.priceCents ?? product.priceCents;
  const available = selectedVariant ? selectedVariant.available : product.available;
  const disabled = !hasVariants ? product.available <= 0 : !selectedVariant || !selectedVariant.inStock;
  const max = Math.max(1, Math.min(available, 99));

  /**
   * ¿La combinación de esta opción con las demás elegidas tiene stock?
   * Permite mostrar opciones agotadas sin dejar de mostrar las disponibles.
   */
  const isOptionAvailable = (axis: string, value: string): boolean => {
    const candidate = variantKeyFromOptionValues({ ...selected, [axis]: value });
    const variant = product.variants.find((item) => item.variantKey === candidate);
    return Boolean(variant?.inStock);
  };

  const priceOfOption = (axis: string, value: string): number | null => {
    const candidate = variantKeyFromOptionValues({ ...selected, [axis]: value });
    return product.variants.find((item) => item.variantKey === candidate)?.priceCents ?? null;
  };

  const cartSnapshot = (): Product => ({
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    // `Product.price` (carrito) va en UNIDADES: única conversión del flujo.
    price: centsToUnits(priceCents),
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
  });

  const handleAdd = () => {
    if (disabled) return;
    if (hasVariants && !selectedVariant) {
      toast.error(t('product.chooseCombination'));
      return;
    }

    // Snapshot de presentación. El checkout vuelve a resolver tienda, variante,
    // precio y stock contra la base.
    const result = addItem(cartSnapshot(), quantity, selectedVariant ? selected : undefined);
    if (result.status === 'conflict') {
      setConflict(result);
      return;
    }
    toast.success(t('product.added', { quantity, name: product.name }));
  };

  const confirmSwitch = () => {
    if (!conflict) return;
    switchStore(cartSnapshot(), quantity, selectedVariant ? selected : undefined);
    setConflict(null);
    toast.success(t('product.switched', { store: product.storeName }));
  };

  return (
    <>
      <section
        aria-label={t('product.buyBox')}
        className="mt-6 flex flex-col gap-5 border-t border-border pt-5"
      >
        {/* 1–2. Precio y disponibilidad. `aria-live` avisa el cambio al elegir
            variante: sin esto, un lector de pantalla no se entera de que el
            precio pasó de S/ 12,00 a S/ 24,00. */}
        <div aria-live="polite" aria-atomic="true">
          <div className="font-mono text-4xl font-semibold tabular-nums tracking-tight">
            {formatMoney(priceCents, product.currency, locale)}
          </div>
          <div
            className={`mt-1 text-body font-medium ${disabled ? 'text-destructive' : 'text-success'}`}
          >
            {disabled
              ? selectedVariant
                ? t('product.combinationOut')
                : hasVariants
                  ? t('product.chooseOption')
                  : t('product.outOfStock')
              : t('product.inStock', { count: available })}
            {!hasVariants && product.unit !== 'unidad' && !disabled && (
              <span className="text-tertiary"> · {t('store.perUnit', { unit: product.unit })}</span>
            )}
          </div>
        </div>

        {/* 3. Variantes como opciones visibles, con estado seleccionado,
            hover, focus y agotado. */}
        {hasVariants &&
          product.optionSchema.map((axis) => (
            <fieldset key={axis.name} className="min-w-0">
              <legend className="mb-2 text-body font-semibold text-primary">
                {t('product.chooseAxis', { axis: axisLabel(axis.name, locale) })}
              </legend>
              <div className="flex flex-wrap gap-2">
                {axis.values.map((value) => {
                  const isSelected = selected[axis.name] === value;
                  const optionAvailable = isOptionAvailable(axis.name, value);
                  const optionPrice = priceOfOption(axis.name, value);
                  const showPrice = optionPrice !== null && optionPrice !== product.priceCents;

                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setSelected((current) => ({ ...current, [axis.name]: value }));
                        setQuantity(1);
                      }}
                      className={`min-h-12 rounded-xl border px-4 py-2 text-left text-body transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--um-brand)] ${
                        isSelected
                          ? 'border-[var(--um-brand)] bg-[var(--um-brand)] font-semibold text-[var(--um-background)]'
                          : 'border-border-strong text-primary hover:bg-surface-raised'
                      } ${!optionAvailable && !isSelected ? 'opacity-60' : ''}`}
                    >
                      <span className="block">{value}</span>
                      <span
                        className={`block text-sm ${
                          isSelected ? 'opacity-80' : 'text-tertiary'
                        }`}
                      >
                        {optionAvailable
                          ? showPrice
                            ? formatMoney(optionPrice, product.currency, locale)
                            : null
                          : t('product.optionOutOfStock')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}

        {/* 4. Cantidad. Los botones y el input conservan un área táctil de 48 px. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body font-semibold text-primary">{t('product.quantity')}</span>
          <div className="flex items-center rounded-xl border border-border-strong">
            <button
              type="button"
              onClick={() => setQuantity((value) => Math.max(1, value - 1))}
              disabled={quantity <= 1 || disabled}
              aria-label={t('product.decrease')}
              className="h-12 w-12 text-2xl leading-none disabled:opacity-40"
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
              className="h-12 w-14 border-x border-border bg-transparent text-centertext-body-lg font-mono tabular-nums"
            />
            <button
              type="button"
              onClick={() => setQuantity((value) => Math.min(max, value + 1))}
              disabled={quantity >= max || disabled}
              aria-label={t('product.increase')}
              className="h-12 w-12 text-2xl leading-none disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>

        {/* 5. Acción primaria única. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={handleAdd}
            disabled={disabled}
            className="h-14 flex-1 rounded-xl bg-brand px-6text-body-lg font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {disabled ? t('product.unavailable') : t('product.addToCart')}
          </button>
          <Link
            href="/cart"
            className="inline-flex h-14 items-center justify-center rounded-xl border border-border-strong px-5 text-body font-medium hover:bg-surface-raised"
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
            <h2 id="cart-store-conflict-title" className="text-xl font-semibold">
              {t('product.conflictTitle')}
            </h2>
            <p className="mt-2 text-body text-secondary">
              {t('product.conflictBody', {
                current: conflict.current.storeName ?? t('product.otherStore'),
                next: conflict.next.storeName ?? t('product.thisStore'),
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
