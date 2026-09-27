"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCartStore, cartLineKey, cartItemVariant } from "@/lib/cartStore";
import { useHydrated } from "@/lib/useHydrated";
import { toast } from "sonner";

/**
 * UUID v4 para la idempotencia del checkout.
 * `crypto.randomUUID()` solo existe en contextos seguros (https / localhost), así
 * que hay un respaldo por si pruebas desde una IP de la LAN por http.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** El backend cobra en Soles (PEN). */
function money(value: number): string {
  return `S/ ${value.toFixed(2)}`;
}

export default function CartPage() {
  const { items, removeItem, updateQuantity, clearCart, getTotalPrice } = useCartStore();
  const router = useRouter();
  // Ver `lib/useHydrated.ts`: el carrito vive en localStorage, así que no se puede
  // pintar hasta después del montaje sin romper la hidratación.
  const hydrated = useHydrated();

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Una clave por INTENTO de pago, no por render.
   *
   * Se reutiliza mientras el envío falle, así un reintento devuelve el MISMO pedido
   * en vez de crear dos. Se descarta cuando el carrito cambia, porque eso ya es
   * otro pedido (otra intención de pago).
   */
  const idempotencyKeyRef = useRef<string | null>(null);

  const cartSignature = items
    .map((item) => `${cartLineKey(item)}x${item.quantity}`)
    .sort()
    .join("|");

  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [cartSignature]);

  const total = getTotalPrice();

  const handleCheckout = async () => {
    if (isSubmitting) return;

    const contactEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      toast.error("Enter your email so we can send you the order confirmation.");
      return;
    }

    // Se crea una sola vez y sobrevive a los reintentos fallidos.
    const idempotencyKey =
      idempotencyKeyRef.current ?? (idempotencyKeyRef.current = newIdempotencyKey());

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          contactEmail,
          fullName: fullName.trim() || undefined,
          // DNI: Mercado Pago lo pide para el cobro con Yape/Plin (sin RUC).
          docType: docNumber.trim() ? "DNI" : undefined,
          docNumber: docNumber.trim() || undefined,
          // El negocio opera con retiro en Locker. El locker/slot concreto lo asigna
          // operación al marcar el pedido como listo, no el checkout.
          fulfillmentType: "pickup_locker",
          items: items.map((item) => ({
            productSlug: item.slug,
            quantity: item.quantity,
            // Solo opciones: el servidor valida la combinación y recalcula nombre y
            // precio contra el catálogo. `cartItemVariant` normaliza carritos antiguos.
            variant: cartItemVariant(item),
          })),
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // El pedido NO se creó: conservamos el carrito y la misma clave de idempotencia,
        // por lo que reintentar es seguro.
        toast.error(payload?.error ?? "We could not place your order. Please try again.");
        return;
      }

      const publicToken = payload?.order?.publicToken;
      clearCart();

      if (publicToken) {
        router.push(`/pedido/${publicToken}`);
      } else {
        toast.success("Order created.");
      }
    } catch {
      toast.error("Network error. Your order was not placed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  /*
    Mismo markup en servidor y primer render del cliente: el carrito recién aparece
    cuando `useHydrated` pasa a true. Si en cambio renderizáramos `items` directo,
    el primer render del cliente ya tendría los productos rehidratados y React
    tiraría el error de hidratación en la consola.
  */
  if (!hydrated) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-6">🛍️</div>
          <h1 className="text-4xl tracking-tight mb-4">Your cart</h1>
          <p className="text-white/60">Loading your items…</p>
        </div>
      </div>
    );
  }

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
            <div key={cartLineKey(item)} className="flex gap-6 border border-white/10 bg-neutral-900 p-6 rounded-3xl">
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
                    {Object.values(cartItemVariant(item)).filter(Boolean).length > 0 && (
                      <div className="text-sm text-white/50 mt-1">
                        {Object.values(cartItemVariant(item)).filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-xl tracking-tight text-right">
                    {money(item.price * item.quantity)}
                  </div>
                </div>

                <div className="flex items-center gap-4 mt-4">
                  <div className="flex items-center border border-white/20 rounded-full">
                    <button 
                      onClick={() => updateQuantity(cartLineKey(item), item.quantity - 1)}
                      disabled={isSubmitting}
                      className="px-3 py-1 hover:bg-white/10 rounded-l-full disabled:opacity-40"
                    >
                      −
                    </button>
                    <div className="px-4 font-mono">{item.quantity}</div>
                    <button 
                      onClick={() => updateQuantity(cartLineKey(item), item.quantity + 1)}
                      disabled={isSubmitting}
                      className="px-3 py-1 hover:bg-white/10 rounded-r-full disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>

                  <button 
                    onClick={() => removeItem(cartLineKey(item))}
                    disabled={isSubmitting}
                    className="text-sm text-white/50 hover:text-white/80 disabled:opacity-40"
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
          <div className="font-mono tracking-tighter">{money(total)}</div>
        </div>

        {/*
          Datos de contacto: `POST /api/orders` exige `contactEmail` (la columna
          `orders.contact_email` es NOT NULL). El checkout completo —dirección de
          entrega, delivery, cupones— llega en una fase posterior.
        */}
        <div className="mt-10 border-t border-white/10 pt-8">
          <h2 className="text-sm tracking-widest text-white/60 mb-4">CONTACT DETAILS</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email *"
              autoComplete="email"
              className="sm:col-span-2 h-12 rounded-2xl border border-white/20 bg-neutral-900 px-4 text-white placeholder:text-white/40 focus:border-white/50 focus:outline-none"
            />
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Full name (optional)"
              autoComplete="name"
              className="h-12 rounded-2xl border border-white/20 bg-neutral-900 px-4 text-white placeholder:text-white/40 focus:border-white/50 focus:outline-none"
            />
            <input
              type="text"
              inputMode="numeric"
              value={docNumber}
              onChange={(event) => setDocNumber(event.target.value)}
              placeholder="DNI (optional)"
              className="h-12 rounded-2xl border border-white/20 bg-neutral-900 px-4 text-white placeholder:text-white/40 focus:border-white/50 focus:outline-none"
            />
          </div>
          <p className="mt-3 text-xs text-white/40">
            We hold your items for 30 minutes after you place the order.
          </p>
        </div>

        <div className="mt-8 flex gap-4">
          <button 
            onClick={handleCheckout}
            disabled={isSubmitting}
            className="flex-1 h-14 rounded-2xl bg-white text-black font-medium hover:bg-white/90 transition-colors disabled:cursor-not-allowed disabled:bg-white/60"
          >
            {isSubmitting ? "Placing order…" : "Proceed to Checkout"}
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
          disabled={isSubmitting}
          className="mt-6 text-xs text-white/40 hover:text-white/70 disabled:opacity-40"
        >
          Clear cart
        </button>
      </div>
    </div>
  );
}
