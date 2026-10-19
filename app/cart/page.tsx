"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCartStore, cartLineKey, cartItemVariant } from "@/lib/cartStore";
import { useHydrated } from "@/lib/useHydrated";
import {
  buildCheckoutSummary,
  isValidContactEmail,
  parseOrderErrorPayload,
  transitionCheckout,
  type CheckoutEvent,
  type CheckoutPhase,
  type ParsedOrderError,
} from "@/lib/checkout";
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
  const [phase, setPhase] = useState<CheckoutPhase>("cart");
  // El error se guarda junto a la firma del carrito: si el carrito cambia, el
  // error viejo deja de mostrarse sin necesidad de un setState dentro de un effect.
  const [orderErrorState, setOrderErrorState] = useState<{
    signature: string;
    error: ParsedOrderError;
  } | null>(null);

  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Una clave por INTENTO de pago, no por render.
   *
   * Se crea recién al confirmar y se reutiliza mientras el envío falle, así un
   * reintento devuelve el MISMO pedido en vez de crear dos. Se descarta cuando el
   * carrito cambia, porque eso ya es otra intención de pago.
   */
  const idempotencyKeyRef = useRef<string | null>(null);

  const cartSignature = items
    .map((item) => `${cartLineKey(item)}x${item.quantity}`)
    .sort()
    .join("|");

  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [cartSignature]);

  const orderError =
    orderErrorState && orderErrorState.signature === cartSignature ? orderErrorState.error : null;

  const setOrderError = (error: ParsedOrderError | null) => {
    setOrderErrorState(error ? { signature: cartSignature, error } : null);
  };

  const isSubmitting = phase === "submitting";
  const isConfirming = phase === "confirming";
  const total = getTotalPrice();

  // Un pedido pertenece a UNA tienda. Se puede llenar el carrito desde varias
  // vitrinas, pero el checkout exige comprar una a la vez; el servidor también
  // rechaza productos que no sean de la tienda declarada.
  const cartStores = new Set(items.map((item) => item.storeSlug ?? "umantai"));
  const isMixedStores = cartStores.size > 1;

  const summary = useMemo(
    () =>
      buildCheckoutSummary(
        items.map((item) => ({
          name: item.name,
          brand: item.brand,
          price: item.price,
          quantity: item.quantity,
          variant: cartItemVariant(item),
        })),
      ),
    [items],
  );

  const advance = useCallback((event: CheckoutEvent) => {
    setPhase((current) => transitionCheckout(current, event));
  }, []);

  // Escape cierra la confirmación, salvo que la petición esté en vuelo.
  useEffect(() => {
    if (!isConfirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        setOrderErrorState(null);
        advance("cancel");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    confirmButtonRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advance, isConfirming, isSubmitting]);

  const handleOpenConfirmation = () => {
    if (isSubmitting) return;
    if (isMixedStores) {
      toast.error("Tu carrito tiene productos de varias tiendas. Compra una tienda a la vez.");
      return;
    }
    if (!isValidContactEmail(email)) {
      toast.error("Enter your email so we can send you the order confirmation.");
      return;
    }
    setOrderError(null);
    advance("open");
  };

  const handleCancelConfirmation = () => {
    if (isSubmitting) return;
    setOrderError(null);
    advance("cancel");
  };

  const handleConfirmPurchase = async () => {
    // Doble candado: el reducer ignora `confirm` fuera de `confirming` y el estado
    // deshabilita el botón. Un doble clic no dispara dos POST.
    if (phase !== "confirming") return;
    advance("confirm");

    const contactEmail = email.trim();
    const idempotencyKey =
      idempotencyKeyRef.current ?? (idempotencyKeyRef.current = newIdempotencyKey());

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
          // Todas las líneas deben ser de la misma tienda. La UI bloquea el
          // checkout mixto; el servidor igual valida producto por producto.
          storeSlug: items[0]?.storeSlug,
          items: items.map((item) => ({
            productSlug: item.slug,
            storeSlug: item.storeSlug,
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
        const parsed = parseOrderErrorPayload(payload);
        setOrderError(parsed);
        advance("failure");
        if (parsed.shortages.length === 0) toast.error(parsed.message);
        return;
      }

      const publicToken = payload?.order?.publicToken;
      advance("success");
      clearCart();

      if (publicToken) {
        router.push(`/pedido/${publicToken}`);
      } else {
        toast.success("Order created.");
      }
    } catch {
      setOrderError({
        message: "Network error. Your order was not placed.",
        code: null,
        shortages: [],
      });
      advance("failure");
      toast.error("Network error. Your order was not placed.");
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
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-black font-medium hover:bg-white/90"
          >
            Buscar productos
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-4xl mx-auto px-8 py-12">
        <h1 className="text-5xl tracking-tighter font-semibold mb-2">Your Cart</h1>
        <p className="mb-8 text-sm text-white/50">
          Tienda: {items[0]?.storeName ?? items[0]?.storeSlug ?? 'UMANTAI'}
        </p>

        {isMixedStores && (
          <div role="alert" className="mb-6 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm">
            Tu carrito contiene productos de tiendas distintas (formato antiguo). Un pedido pertenece
            a una sola tienda. Vacía el carrito y agrega los productos de la tienda que quieras comprar.
            <button
              type="button"
              onClick={() => {
                clearCart();
                toast.info('Carrito vacío. Elige una tienda.');
              }}
              className="ml-2 underline underline-offset-2 hover:text-white"
            >
              Vaciar carrito
            </button>
          </div>
        )}

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
                      type="button"
                      aria-label={`Decrease quantity of ${item.name}`}
                      onClick={() => updateQuantity(cartLineKey(item), item.quantity - 1)}
                      disabled={isSubmitting}
                      className="px-3 py-1 hover:bg-white/10 rounded-l-full disabled:opacity-40"
                    >
                      −
                    </button>
                    <div className="px-4 font-mono">{item.quantity}</div>
                    <button
                      type="button"
                      aria-label={`Increase quantity of ${item.name}`}
                      onClick={() => updateQuantity(cartLineKey(item), item.quantity + 1)}
                      disabled={isSubmitting}
                      className="px-3 py-1 hover:bg-white/10 rounded-r-full disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>

                  <button
                    type="button"
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
            type="button"
            onClick={handleOpenConfirmation}
            disabled={isSubmitting}
            className="flex-1 h-14 rounded-2xl bg-white text-black font-medium hover:bg-white/90 transition-colors disabled:cursor-not-allowed disabled:bg-white/60"
          >
            Review order
          </button>
          <Link
            href="/"
            className="flex-1 h-14 rounded-2xl border border-white/40 font-medium hover:bg-white/5 transition-colors flex items-center justify-center"
          >
            Seguir comprando
          </Link>
        </div>

        <button
          type="button"
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

      {isConfirming && (
        <div
          className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleCancelConfirmation();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-confirm-title"
            className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-white/15 bg-neutral-900 p-6 sm:p-8"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="uppercase tracking-[3px] text-xs text-white/50">PASO FINAL</div>
                <h2 id="checkout-confirm-title" className="text-3xl font-semibold tracking-tight mt-1">
                  Confirm your purchase
                </h2>
                <p className="text-sm text-white/60 mt-2">
                  Review the items. Your stock is reserved only after you confirm.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCancelConfirmation}
                disabled={isSubmitting}
                aria-label="Close confirmation"
                className="text-2xl text-white/50 hover:text-white disabled:opacity-40"
              >
                ×
              </button>
            </div>

            <ul className="mt-6 divide-y divide-white/10 border-y border-white/10">
              {summary.lines.map((line, index) => (
                <li key={`${line.name}-${index}`} className="py-4 flex justify-between gap-4">
                  <div>
                    <div className="font-medium">{line.name}</div>
                    {line.brand && <div className="text-xs text-white/50">{line.brand}</div>}
                    {line.variantLabel && (
                      <div className="text-xs text-white/60 mt-1">{line.variantLabel}</div>
                    )}
                    <div className="text-sm text-white/60 mt-1">
                      {line.quantity} × {money(line.unitPrice)}
                    </div>
                  </div>
                  <div className="font-mono text-right">{money(line.lineTotal)}</div>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex justify-between text-sm text-white/70">
              <span>Subtotal</span>
              <span className="font-mono">{money(summary.subtotal)}</span>
            </div>
            <div className="mt-2 flex justify-between text-lg font-medium">
              <span>Total</span>
              <span className="font-mono tracking-tight">{money(summary.total)}</span>
            </div>
            <p className="text-xs text-white/40 mt-1">
              Prices are recalculated on the server before creating the order.
            </p>

            {orderError && (
              <div
                role="alert"
                className="mt-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100"
              >
                <p className="font-medium">{orderError.message}</p>
                {orderError.shortages.length > 0 && (
                  <>
                    <p className="mt-2 text-red-200/90">These items no longer have enough stock:</p>
                    <ul className="mt-2 space-y-1">
                      {orderError.shortages.map((shortage) => (
                        <li key={`${shortage.productSlug}:${shortage.variantKey}`}>
                          <span className="font-medium">
                            {shortage.productName ?? shortage.productSlug}
                          </span>
                          {shortage.variantKey && (
                            <span className="text-red-200/80"> ({shortage.variantKey})</span>
                          )}
                          : you asked {shortage.requested}, available {shortage.available}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={handleCancelConfirmation}
                      className="mt-3 rounded-full border border-red-300/40 px-4 py-1.5 text-xs hover:bg-red-500/10"
                    >
                      Back to cart and fix quantities
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3">
              <button
                type="button"
                onClick={handleCancelConfirmation}
                disabled={isSubmitting}
                className="flex-1 h-12 rounded-2xl border border-white/30 font-medium hover:bg-white/5 disabled:opacity-40"
              >
                Volver al carrito
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={() => void handleConfirmPurchase()}
                disabled={isSubmitting}
                className="flex-1 h-12 rounded-2xl bg-white text-black font-medium hover:bg-white/90 disabled:bg-white/60 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Creating order…" : "Confirmar compra"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
