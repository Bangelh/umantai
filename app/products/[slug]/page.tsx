"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getProductBySlug, getProductOptions } from "@/lib/products";
import { useAdminProductStore } from "@/lib/adminProductStore";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";
import { variantKeyForSelection, type ProductVariant } from "@/lib/commerce";
import { toast } from "sonner";

/** Disponibilidad por variante devuelta por /api/catalog/availability. */
type VariantAvailability = Record<string, number>;

export default function ProductPage() {
  const { loadFromDatabase } = useAdminProductStore();

  // Load latest published data from Postgres so price/stock changes appear without rebuild
  useEffect(() => {
    loadFromDatabase();
  }, [loadFromDatabase]);

  const params = useParams<{ slug: string }>();
  const product = getProductBySlug(params.slug);

  const options = useMemo(() => (product ? getProductOptions(product) : []), [product]);
  const hasOptions = options.length > 0;

  const [selection, setSelection] = useState<Record<string, string>>({});
  const [availability, setAvailability] = useState<VariantAvailability | null>(null);

  // Disponibilidad real por variante (autoridad: `inventory`). Si falla, se conserva
  // la disponibilidad de presentación del catálogo; el servidor sigue siendo el que
  // autoriza la venta.
  useEffect(() => {
    if (!product) return;
    let active = true;

    fetch(`/api/catalog/availability?slug=${encodeURIComponent(product.slug)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active || !data?.availability?.[product.slug]) return;
        setAvailability(data.availability[product.slug].variants as VariantAvailability);
      })
      .catch(() => {
        /* sin datos de inventario: la venta la sigue validando el servidor */
      });

    return () => {
      active = false;
    };
  }, [product]);

  if (!product) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-white">
        <div className="text-center">
          <div className="text-6xl mb-4">404</div>
          <h1 className="text-3xl mb-4">Product not found</h1>
          <Link href="/products" className="text-white/70 hover:text-white">
            Back to collection →
          </Link>
        </div>
      </div>
    );
  }

  // `variant_key` canónico de la selección actual, o `null` si está incompleta.
  const selectionKey = variantKeyForSelection(options, selection);
  const isSelectionComplete = selectionKey !== null;

  // Cuánto queda de la variante elegida. `null` = todavía no sabemos (sin inventario).
  const selectedAvailable =
    availability && selectionKey !== null ? availability[selectionKey] ?? 0 : null;

  const catalogStock = product.inStock; // solo presentación, no autoridad
  const isOutOfStock =
    isSelectionComplete && selectedAvailable !== null && selectedAvailable <= 0;
  const canAdd = isSelectionComplete && !isOutOfStock;

  const selectOption = (name: string, value: string) => {
    setSelection((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddToCart = () => {
    if (!canAdd || selectionKey === null) {
      toast.error("Please select every option first.");
      return;
    }
    const variant = Object.keys(selection).length > 0 ? (selection as ProductVariant) : undefined;
    useCartStore.getState().addItem(product, 1, variant);
    toast.success(`Added ${product.name} to cart`);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-6xl mx-auto px-8 pt-8 pb-20">
        <Link href="/products" className="text-sm text-white/60 hover:text-white mb-8 inline-block">
          ← Back to Collection
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          {/* Images */}
          <div>
            <div className="aspect-[4/3] bg-neutral-900 rounded-3xl mb-4 flex items-center justify-center text-8xl">
              {product.brand === "Apple" && "📱"}
              {product.brand === "Dyson" && "🌀"}
              {product.brand === "Oura" && "💍"}
              {product.brand === "Peak Design" && "🎒"}
              {product.brand === "Bose" && "🎧"}
              {product.brand === "Samsung" && "📱"}
              {product.brand === "Whoop" && "⌚"}
              {product.brand === "Sonos" && "🔊"}
              {product.brand === "Anker" && "🔋"}
              {product.brand === "Blue Bottle" && "☕"}
              {product.brand === "Patagonia" && "🐟"}
              {product.brand === "Google" && "📱"}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {product.images.slice(0, 3).map((img, index) => (
                <div key={index} className="aspect-square bg-neutral-900 rounded-2xl flex items-center justify-center text-4xl">
                  {index === 0 && (product.brand === "Apple" ? "📱" : "✨")}
                  {index === 1 && "📸"}
                  {index === 2 && "🔍"}
                </div>
              ))}
            </div>
          </div>

          {/* Details */}
          <div>
            {product.bestseller && (
              <div className="inline-block text-xs tracking-widest px-4 py-1 bg-white text-black rounded-full mb-4">
                Bestseller
              </div>
            )}

            <div className="text-sm text-white/60">{product.brand}</div>
            <h1 className="text-5xl tracking-tighter font-semibold mt-1">{product.name}</h1>

            <div className="text-4xl font-medium tracking-tighter mt-4">${product.price}</div>

            {/* Disponibilidad: real por variante cuando se pudo leer el inventario. */}
            {!isSelectionComplete && hasOptions ? (
              <div className="mt-2 text-sm text-white/60">Select your options to see availability</div>
            ) : isOutOfStock ? (
              <div className="mt-2 text-sm text-red-400 font-medium">Currently out of stock</div>
            ) : selectedAvailable !== null ? (
              <div className="mt-2 text-sm text-emerald-400">
                In stock • {selectedAvailable} available
              </div>
            ) : catalogStock > 0 ? (
              <div className="mt-2 text-sm text-emerald-400">In stock</div>
            ) : (
              <div className="mt-2 text-sm text-red-400 font-medium">Currently out of stock</div>
            )}

            <div className="flex items-center gap-2 mt-3">
              <div className="text-yellow-400">★★★★★</div>
              <div className="text-sm text-white/70">
                {product.rating} ({product.reviewCount} reviews)
              </div>
            </div>

            <p className="mt-6 text-lg text-white/80 leading-relaxed">{product.description}</p>

            {/* Opciones genéricas: la selección es obligatoria antes de agregar al carrito. */}
            {options.map((option) => (
              <div className="mt-8" key={option.name}>
                <div className="text-sm tracking-widest mb-3 text-white/60 uppercase">
                  {option.name}
                  {selection[option.name] && (
                    <span className="ml-2 text-white/80 normal-case tracking-normal">
                      {selection[option.name]}
                    </span>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {option.values.map((value) => {
                    const active = selection[option.name] === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => selectOption(option.name, value)}
                        aria-pressed={active}
                        className={`px-4 py-2 text-sm border rounded-full transition-colors ${
                          active
                            ? "border-white bg-white text-black"
                            : "border-white/30 hover:bg-white/5"
                        }`}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="flex gap-4 mt-8">
              <button
                onClick={handleAddToCart}
                disabled={!canAdd}
                className="flex-1 h-14 rounded-2xl bg-white text-black font-medium hover:bg-white/90 transition-colors disabled:bg-white/50 disabled:text-black/50 disabled:cursor-not-allowed"
              >
                {isOutOfStock
                  ? "Out of Stock"
                  : !isSelectionComplete && hasOptions
                    ? "Select options"
                    : "Add to Cart"}
              </button>
              <button
                onClick={() => {
                  useShoppingListStore.getState().addItem(product);
                  toast.success(`Added ${product.name} to your list`);
                }}
                className="flex-1 h-14 rounded-2xl border border-white/40 font-medium hover:bg-white/5 transition-colors"
              >
                Add to Shopping List
              </button>
            </div>

            <div className="mt-4 text-center text-xs text-white/50">
              Ready for Pickup in 12 minutes at flagship
            </div>

            {/* Specifications */}
            <div className="mt-12">
              <div className="text-sm tracking-widest mb-4 text-white/60">SPECIFICATIONS</div>
              <div className="grid grid-cols-2 gap-y-4 text-sm">
                {product.specs.map((spec, index) => (
                  <div key={index} className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-white/40" />
                    {spec}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
