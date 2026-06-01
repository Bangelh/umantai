"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { getProductBySlug } from "@/lib/products";
import { useAdminProductStore } from "@/lib/adminProductStore";
import { useCartStore } from "@/lib/cartStore";
import { useShoppingListStore } from "@/lib/shoppingListStore";
import { toast } from "sonner";

export default function ProductPage() {
  const { loadFromDatabase } = useAdminProductStore();

  // Load latest published data from Postgres so price/stock changes appear without rebuild
  useEffect(() => {
    loadFromDatabase();
  }, [loadFromDatabase]);

  const params = useParams<{ slug: string }>();
  const product = getProductBySlug(params.slug);

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

            {product.inStock > 0 ? (
              <div className="mt-2 text-sm text-emerald-400">
                In stock • {product.inStock} available
              </div>
            ) : (
              <div className="mt-2 text-sm text-red-400 font-medium">
                Currently out of stock
              </div>
            )}

            <div className="flex items-center gap-2 mt-3">
              <div className="text-yellow-400">★★★★★</div>
              <div className="text-sm text-white/70">
                {product.rating} ({product.reviewCount} reviews)
              </div>
            </div>

            <p className="mt-6 text-lg text-white/80 leading-relaxed">{product.description}</p>

            {/* Color / Storage Options */}
            {product.colors && (
              <div className="mt-8">
                <div className="text-sm tracking-widest mb-3 text-white/60">COLOR</div>
                <div className="flex gap-2 flex-wrap">
                  {product.colors.map((color) => (
                    <button key={color} className="px-4 py-2 text-sm border border-white/30 rounded-full hover:bg-white/5">
                      {color}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {product.storage && (
              <div className="mt-6">
                <div className="text-sm tracking-widest mb-3 text-white/60">STORAGE</div>
                <div className="flex gap-2">
                  {product.storage.map((size) => (
                    <button key={size} className="px-5 py-2 text-sm border border-white/30 rounded-full hover:bg-white/5">
                      {size}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-4 mt-8">
              <button 
                onClick={() => {
                  useCartStore.getState().addItem(product);
                  toast.success(`Added ${product.name} to cart`);
                }}
                disabled={product.inStock === 0}
                className="flex-1 h-14 rounded-2xl bg-white text-black font-medium hover:bg-white/90 transition-colors disabled:bg-white/50 disabled:text-black/50 disabled:cursor-not-allowed"
              >
                {product.inStock > 0 ? "Add to Cart" : "Out of Stock"}
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
