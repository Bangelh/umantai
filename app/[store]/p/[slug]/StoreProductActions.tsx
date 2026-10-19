'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCartStore } from '@/lib/cartStore';
import type { Product } from '@/lib/products';

interface Props {
  product: {
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
  };
}

export function StoreProductActions({ product }: Props) {
  const addItem = useCartStore((state) => state.addItem);
  const [quantity, setQuantity] = useState(1);

  const max = Math.max(1, Math.min(product.available, 99));
  const disabled = product.available <= 0;

  const handleAdd = () => {
    if (disabled) return;

    // Se guarda un snapshot de presentación; el checkout vuelve a resolver el
    // precio contra `store_products` en el servidor.
    const cartProduct: Product = {
      slug: product.slug,
      name: product.name,
      brand: product.brand,
      price: product.price,
      category: product.category,
      description: product.description,
      specs: [],
      inStock: product.available,
      rating: 0,
      reviewCount: 0,
      images: product.imageUrl ? [product.imageUrl] : [],
      storeSlug: product.storeSlug,
      storeName: product.storeName,
    };

    addItem(cartProduct, quantity);
    toast.success(`Agregado: ${quantity} × ${product.name}`);
  };

  return (
    <section className="mt-6 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
      <div className="flex items-center gap-2">
        <label htmlFor="store-product-qty" className="text-xs uppercase tracking-[1.5px] text-muted">
          Cantidad
        </label>
        <div className="flex items-center rounded-xl border border-border-strong">
          <button
            type="button"
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            disabled={quantity <= 1 || disabled}
            aria-label="Quitar una unidad"
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
            aria-label="Cantidad"
            className="h-11 w-12 border-x border-border bg-transparent text-center font-mono tabular-nums"
          />
          <button
            type="button"
            onClick={() => setQuantity((value) => Math.min(max, value + 1))}
            disabled={quantity >= max || disabled}
            aria-label="Agregar una unidad"
            className="h-11 w-11 text-lg disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={handleAdd}
        disabled={disabled}
        className="h-12 flex-1 rounded-xl bg-brand px-6 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {disabled ? 'Agotado' : 'Agregar al carrito'}
      </button>

      <Link
        href="/cart"
        className="inline-flex h-12 items-center justify-center rounded-xl border border-border-strong px-5 text-sm font-medium hover:bg-surface-raised"
      >
        Ver carrito
      </Link>
    </section>
  );
}
