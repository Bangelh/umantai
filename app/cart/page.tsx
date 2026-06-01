"use client";

import Link from "next/link";
import { useCartStore } from "@/lib/cartStore";
import { toast } from "sonner";

export default function CartPage() {
  const { items, removeItem, updateQuantity, clearCart, getTotalPrice } = useCartStore();

  const total = getTotalPrice();

  const handleCheckout = () => {
    toast.success("Thank you! This is a demo — in production this would process payment.");
    // In a real app: redirect to checkout or open a modal
  };

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-6">🛍️</div>
          <h1 className="text-4xl tracking-tight mb-4">Your cart is empty</h1>
          <p className="text-white/60 mb-8">Browse our collection and discover exceptional pieces.</p>
          <Link 
            href="/products" 
            className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-black font-medium hover:bg-white/90"
          >
            Browse the Collection
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-4xl mx-auto px-8 py-12">
        <h1 className="text-5xl tracking-tighter font-semibold mb-10">Your Cart</h1>

        <div className="space-y-6">
          {items.map((item) => (
            <div key={item.slug} className="flex gap-6 border border-white/10 bg-neutral-900 p-6 rounded-3xl">
              <div className="w-24 h-24 bg-neutral-800 rounded-2xl flex-shrink-0 flex items-center justify-center text-4xl">
                {item.brand === "Apple" && "📱"}
                {item.brand === "Dyson" && "🌀"}
                {item.brand === "Oura" && "💍"}
                {item.brand === "Peak Design" && "🎒"}
                {item.brand === "Bose" && "🎧"}
                {item.brand === "Samsung" && "📱"}
                {item.brand === "Whoop" && "⌚"}
                {item.brand === "Sonos" && "🔊"}
                {item.brand === "Anker" && "🔋"}
                {item.brand === "Blue Bottle" && "☕"}
                {item.brand === "Patagonia" && "🐟"}
                {item.brand === "Google" && "📱"}
              </div>

              <div className="flex-1">
                <div className="flex justify-between">
                  <div>
                    <div className="text-sm text-white/60">{item.brand}</div>
                    <div className="text-xl font-semibold tracking-tight">{item.name}</div>
                  </div>
                  <div className="font-mono text-xl tracking-tight text-right">
                    ${(item.price * item.quantity).toFixed(2)}
                  </div>
                </div>

                <div className="flex items-center gap-4 mt-4">
                  <div className="flex items-center border border-white/20 rounded-full">
                    <button 
                      onClick={() => updateQuantity(item.slug, item.quantity - 1)}
                      className="px-3 py-1 hover:bg-white/10 rounded-l-full"
                    >
                      −
                    </button>
                    <div className="px-4 font-mono">{item.quantity}</div>
                    <button 
                      onClick={() => updateQuantity(item.slug, item.quantity + 1)}
                      className="px-3 py-1 hover:bg-white/10 rounded-r-full"
                    >
                      +
                    </button>
                  </div>

                  <button 
                    onClick={() => removeItem(item.slug)}
                    className="text-sm text-white/50 hover:text-white/80"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 border-t border-white/10 pt-8 flex justify-between items-center text-xl">
          <div>Total</div>
          <div className="font-mono tracking-tighter">${total.toFixed(2)}</div>
        </div>

        <div className="mt-8 flex gap-4">
          <button 
            onClick={handleCheckout}
            className="flex-1 h-14 rounded-2xl bg-white text-black font-medium hover:bg-white/90 transition-colors"
          >
            Proceed to Checkout
          </button>
          <Link 
            href="/products"
            className="flex-1 h-14 rounded-2xl border border-white/40 font-medium hover:bg-white/5 transition-colors flex items-center justify-center"
          >
            Continue Shopping
          </Link>
        </div>

        <button 
          onClick={() => {
            clearCart();
            toast.info("Cart cleared");
          }}
          className="mt-6 text-xs text-white/40 hover:text-white/70"
        >
          Clear cart
        </button>
      </div>
    </div>
  );
}
