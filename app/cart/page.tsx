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
import { formatMoneyUnits } from "@/lib/format";
import { useI18n } from "@/components/i18n/I18nProvider";
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

export default function CartPage() {
  const { locale, t } = useI18n();
  const { items, removeItem, updateQuantity, clearCart, getTotalPrice } = useCartStore();
  const router = useRouter();
  // Ver `lib/useHydrated.ts`: el carrito vive en localStorage, así que no se puede
  // pintar hasta después del montaje sin romper la hidratación.
  const hydrated = useHydrated();

  const money = useCallback(
    (value: number) => formatMoneyUnits(value, "PEN", locale),
    [locale],
  );

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
      toast.error(t("cart.mixedToast"));
      return;
    }
    if (!isValidContactEmail(email)) {
      toast.error(t("cart.emailRequired"));
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
        toast.success(t("cart.orderCreated"));
      }
    } catch {
      setOrderError({
        message: t("cart.networkError"),
        code: null,
        shortages: [],
      });
      advance("failure");
      toast.error(t("cart.networkError"));
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
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="text-center" role="status" aria-live="polite">
          <div className="mb-4 text-5xl" aria-hidden="true">
            🛍️
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("cart.title")}</h1>
          <p className="mt-2 text-sm text-tertiary">{t("cart.loading")}</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="text-center">
          <div className="mb-4 text-5xl" aria-hidden="true">
            🛍️
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("cart.emptyTitle")}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-tertiary">{t("cart.emptyBody")}</p>
          <Link
            href="/"
            className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-brand px-6 text-sm font-semibold text-background hover:opacity-90"
          >
            {t("cart.browse")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("cart.title")}</h1>
      <p className="mb-6 mt-1 text-sm text-tertiary">
        {t("cart.store", {
          store: items[0]?.storeName ?? items[0]?.storeSlug ?? "UMANTAI",
        })}
      </p>

      {isMixedStores && (
        <div role="alert" className="mb-6 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          {t("cart.mixedWarning")}
          <button
            type="button"
            onClick={() => {
              clearCart();
              toast.info(t("cart.emptied"));
            }}
            className="ml-2 underline underline-offset-2 hover:text-primary"
          >
            {t("cart.emptyAction")}
          </button>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={cartLineKey(item)}
            className="flex gap-4 rounded-2xl border border-border bg-surface p-4 sm:p-5"
          >
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-raised text-2xl sm:h-20 sm:w-20 sm:text-3xl">
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

            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-tertiary">{item.brand}</div>
                  <div className="truncate text-base font-semibold tracking-tight">{item.name}</div>
                  {Object.values(cartItemVariant(item)).filter(Boolean).length > 0 && (
                    <div className="mt-1 text-xs text-tertiary">
                      {Object.values(cartItemVariant(item)).filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right font-mono text-base font-semibold tabular-nums">
                  {money(item.price * item.quantity)}
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex items-center rounded-full border border-border-strong">
                  <button
                    type="button"
                    aria-label={t("cart.decrease", { name: item.name })}
                    onClick={() => updateQuantity(cartLineKey(item), item.quantity - 1)}
                    disabled={isSubmitting}
                    className="rounded-l-full px-3 py-1 hover:bg-surface-raised disabled:opacity-40"
                  >
                    −
                  </button>
                  <div className="px-3 font-mono tabular-nums">{item.quantity}</div>
                  <button
                    type="button"
                    aria-label={t("cart.increase", { name: item.name })}
                    onClick={() => updateQuantity(cartLineKey(item), item.quantity + 1)}
                    disabled={isSubmitting}
                    className="rounded-r-full px-3 py-1 hover:bg-surface-raised disabled:opacity-40"
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => removeItem(cartLineKey(item))}
                  disabled={isSubmitting}
                  className="text-sm text-tertiary hover:text-primary disabled:opacity-40"
                >
                  {t("cart.remove")}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex items-center justify-between border-t border-border pt-5 text-lg">
        <div>{t("cart.total")}</div>
        <div className="font-mono font-semibold tabular-nums">{money(total)}</div>
      </div>

      {/* Datos de contacto: `POST /api/orders` exige `contactEmail`. */}
      <div className="mt-8 border-t border-border pt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-[2px] text-secondary">
          {t("cart.contact")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            type="email"
            required
            aria-label={t("cart.email")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("cart.email")}
            autoComplete="email"
            className="h-11 rounded-xl border border-border-strong bg-background px-3 text-sm text-primary placeholder:text-muted focus:border-primary focus:outline-none sm:col-span-2"
          />
          <input
            type="text"
            aria-label={t("cart.fullName")}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder={t("cart.fullName")}
            autoComplete="name"
            className="h-11 rounded-xl border border-border-strong bg-background px-3 text-sm text-primary placeholder:text-muted focus:border-primary focus:outline-none"
          />
          <input
            type="text"
            inputMode="numeric"
            aria-label={t("cart.doc")}
            value={docNumber}
            onChange={(event) => setDocNumber(event.target.value)}
            placeholder={t("cart.doc")}
            className="h-11 rounded-xl border border-border-strong bg-background px-3 text-sm text-primary placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </div>
        <p className="mt-2 text-xs text-muted">{t("cart.holdNote")}</p>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={handleOpenConfirmation}
          disabled={isSubmitting}
          className="h-12 flex-1 rounded-xl bg-brand text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("cart.review")}
        </button>
        <Link
          href="/"
          className="flex h-12 flex-1 items-center justify-center rounded-xl border border-border-strong text-sm font-medium hover:bg-surface-raised"
        >
          {t("cart.continue")}
        </Link>
      </div>

      <button
        type="button"
        onClick={() => {
          clearCart();
          toast.info(t("cart.cleared"));
        }}
        disabled={isSubmitting}
        className="mt-5 text-xs text-muted hover:text-secondary disabled:opacity-40"
      >
        {t("cart.clear")}
      </button>

      {isConfirming && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleCancelConfirmation();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-confirm-title"
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-border bg-surface p-5 sm:max-w-2xl sm:rounded-3xl sm:p-7"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[3px] text-muted">
                  {t("cart.confirmKicker")}
                </div>
                <h2 id="checkout-confirm-title" className="mt-1 text-2xl font-semibold tracking-tight">
                  {t("cart.confirmTitle")}
                </h2>
                <p className="mt-1.5 text-sm text-tertiary">{t("cart.confirmBody")}</p>
              </div>
              <button
                type="button"
                onClick={handleCancelConfirmation}
                disabled={isSubmitting}
                aria-label={t("cart.closeConfirm")}
                className="text-2xl text-muted hover:text-primary disabled:opacity-40"
              >
                ×
              </button>
            </div>

            <ul className="mt-5 divide-y divide-border border-y border-border">
              {summary.lines.map((line, index) => (
                <li key={`${line.name}-${index}`} className="flex justify-between gap-4 py-3">
                  <div>
                    <div className="font-medium">{line.name}</div>
                    {line.brand && <div className="text-xs text-tertiary">{line.brand}</div>}
                    {line.variantLabel && (
                      <div className="mt-1 text-xs text-tertiary">{line.variantLabel}</div>
                    )}
                    <div className="mt-1 text-sm text-tertiary">
                      {line.quantity} × {money(line.unitPrice)}
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums">{money(line.lineTotal)}</div>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex justify-between text-sm text-secondary">
              <span>{t("cart.subtotal")}</span>
              <span className="font-mono tabular-nums">{money(summary.subtotal)}</span>
            </div>
            <div className="mt-2 flex justify-between text-lg font-medium">
              <span>{t("cart.total")}</span>
              <span className="font-mono tabular-nums tracking-tight">{money(summary.total)}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{t("cart.pricesServer")}</p>

            {orderError && (
              <div
                role="alert"
                className="mt-5 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <p className="font-medium">{orderError.message}</p>
                {orderError.shortages.length > 0 && (
                  <>
                    <p className="mt-2 opacity-90">{t("cart.shortages")}</p>
                    <ul className="mt-2 space-y-1">
                      {orderError.shortages.map((shortage) => (
                        <li key={`${shortage.productSlug}:${shortage.variantKey}`}>
                          <span className="font-medium">
                            {shortage.productName ?? shortage.productSlug}
                          </span>
                          {shortage.variantKey && (
                            <span className="opacity-80"> ({shortage.variantKey})</span>
                          )}
                          {": "}
                          {t("cart.askedAvailable", {
                            requested: shortage.requested,
                            available: shortage.available,
                          })}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={handleCancelConfirmation}
                      className="mt-3 rounded-full border border-destructive/40 px-4 py-1.5 text-xs hover:bg-destructive/10"
                    >
                      {t("cart.backToFix")}
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
              <button
                type="button"
                onClick={handleCancelConfirmation}
                disabled={isSubmitting}
                className="h-12 flex-1 rounded-xl border border-border-strong font-medium hover:bg-surface-raised disabled:opacity-40"
              >
                {t("cart.backToCart")}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={() => void handleConfirmPurchase()}
                disabled={isSubmitting}
                className="h-12 flex-1 rounded-xl bg-brand font-semibold text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? t("cart.creating") : t("cart.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
