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
 * /cart — carrito y confirmación de compra.
 *
 * Decisiones de esta versión:
 *   · El correo y el nombre se completan con la cuenta iniciada; el invitado
 *     puede escribirlos a mano.
 *   · El botón "−" quita la línea cuando la cantidad ya es 1: llegar a cero es
 *     la forma natural de sacar un producto.
 *   · Hay UN solo paso: "Confirmar compra" abre una pregunta explícita con el
 *     total y el método de pago. Antes había un "Revisar pedido" que repetía el
 *     carrito y no agregaba información.
 *   · Efectivo solo aparece con sesión y si la tienda lo aceptó. El servidor
 *     vuelve a validar ambas cosas.
 */

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type StorePayments = {
  yape: string | null;
  plin: string | null;
  bankAccount: string | null;
  holder: string | null;
  cash: boolean;
};

type PaymentChoice = "yape" | "cash";

export default function CartPage() {
  const { locale, t } = useI18n();
  const { items, removeItem, updateQuantity, clearCart, getTotalPrice } = useCartStore();
  const router = useRouter();
  const hydrated = useHydrated();

  const money = useCallback(
    (value: number) => formatMoneyUnits(value, "PEN", locale),
    [locale],
  );

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [phase, setPhase] = useState<CheckoutPhase>("cart");
  const [prefilled, setPrefilled] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [paymentInfo, setPaymentInfo] = useState<StorePayments | null>(null);
  const [paymentChoice, setPaymentChoice] = useState<PaymentChoice>("yape");
  const [orderErrorState, setOrderErrorState] = useState<{
    signature: string;
    error: ParsedOrderError;
  } | null>(null);

  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const prefillDone = useRef(false);

  const cartSignature = items
    .map((item) => `${cartLineKey(item)}x${item.quantity}`)
    .sort()
    .join("|");

  const storeSlug = items[0]?.storeSlug;

  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [cartSignature]);

  // Cuenta: correo y nombre se completan solos. Un 401 significa invitado.
  useEffect(() => {
    if (prefillDone.current) return;
    prefillDone.current = true;

    void (async () => {
      const response = await fetch("/api/account/profile", {
        headers: { accept: "application/json" },
      }).catch(() => null);
      if (!response || !response.ok) return;

      const payload = (await response.json().catch(() => null)) as
        | {
            profile?: {
              email?: string;
              name?: string;
              fullName?: string | null;
              docNumber?: string | null;
            } | null;
          }
        | null;
      const profile = payload?.profile;
      if (!profile) return;

      setLoggedIn(true);
      if (profile.email) {
        setEmail((current) => current || profile.email || "");
        setPrefilled(true);
      }
      setFullName((current) => current || profile.fullName || profile.name || "");
      setDocNumber((current) => current || profile.docNumber || "");
    })();
  }, []);

  // Datos de pago de la tienda del carrito (Yape/Plin/efectivo).
  useEffect(() => {
    if (!hydrated || !storeSlug) return;
    let cancelled = false;

    void (async () => {
      const response = await fetch(`/api/stores/${encodeURIComponent(storeSlug)}/payment`, {
        headers: { accept: "application/json" },
      }).catch(() => null);
      if (!response || !response.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | { payments?: StorePayments }
        | null;
      if (!cancelled && payload?.payments) setPaymentInfo(payload.payments);
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, storeSlug]);

  const orderError =
    orderErrorState && orderErrorState.signature === cartSignature ? orderErrorState.error : null;

  const setOrderError = (error: ParsedOrderError | null) => {
    setOrderErrorState(error ? { signature: cartSignature, error } : null);
  };

  const isSubmitting = phase === "submitting";
  const isConfirming = phase === "confirming";
  const total = getTotalPrice();

  // Derivado, no un efecto: si el efectivo deja de estar disponible (la tienda
  // lo desactiva o la sesión no existe), la UI vuelve a Yape/Plin sin un render
  // en cascada ni un estado intermedio inválido.
  const cashAvailable = loggedIn && Boolean(paymentInfo?.cash);
  const effectivePaymentChoice: PaymentChoice =
    paymentChoice === "cash" && !cashAvailable ? "yape" : paymentChoice;

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
    if (phase !== "confirming") return;

    if (effectivePaymentChoice === "cash" && !cashAvailable) {
      toast.error(t("cart.paymentCashUnavailable"));
      return;
    }

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
          docType: docNumber.trim() ? "DNI" : undefined,
          docNumber: docNumber.trim() || undefined,
          fulfillmentType: "pickup_locker",
          paymentMethod: effectivePaymentChoice,
          storeSlug: items[0]?.storeSlug,
          items: items.map((item) => ({
            productSlug: item.slug,
            storeSlug: item.storeSlug,
            quantity: item.quantity,
            variant: cartItemVariant(item),
          })),
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
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

  if (!hydrated) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="text-center" role="status" aria-live="polite">
          <h1 className="text-3xl font-semibold tracking-tight">{t("cart.title")}</h1>
          <p className="mt-2 text-body text-tertiary">{t("cart.loading")}</p>
        </div>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">{t("cart.emptyTitle")}</h1>
          <p className="mx-auto mt-2 max-w-sm text-body text-secondary">{t("cart.emptyBody")}</p>
          <Link
            href="/"
            className="mt-6 inline-flex h-12 items-center justify-center rounded-xl bg-brand px-6 text-body font-semibold text-background hover:opacity-90"
          >
            {t("cart.browse")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("cart.title")}</h1>
      <p className="mb-6 mt-1 text-body text-secondary">
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
        {items.map((item) => {
          const variantLabel = Object.values(cartItemVariant(item)).filter(Boolean).join(" · ");

          return (
            <li
              key={cartLineKey(item)}
              className="rounded-2xl border border-border bg-surface p-4 sm:p-5"
            >
              <div className="flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-semibold leading-snug tracking-tight">
                    {item.name}
                  </div>
                  {variantLabel && (
                    <div className="mt-0.5 text-body text-secondary">{variantLabel}</div>
                  )}
                  <div className="mt-1 text-sm text-tertiary">
                    {t("cart.unitPrice")}: {money(item.price)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-body-lg font-semibold tabular-nums">
                    {money(item.price * item.quantity)}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center rounded-xl border border-border-strong">
                  <button
                    type="button"
                    aria-label={
                      item.quantity <= 1
                        ? t("cart.removeNamed", { name: item.name })
                        : t("cart.decrease", { name: item.name })
                    }
                    onClick={() => {
                      if (item.quantity <= 1) removeItem(cartLineKey(item));
                      else updateQuantity(cartLineKey(item), item.quantity - 1);
                    }}
                    disabled={isSubmitting}
                    className="h-12 w-12 rounded-l-xl text-2xl leading-none hover:bg-surface-raised disabled:opacity-40"
                  >
                    −
                  </button>
                  <div
                    aria-live="polite"
                    className="w-12 text-center font-mono text-body-lg tabular-nums"
                  >
                    {item.quantity}
                  </div>
                  <button
                    type="button"
                    aria-label={t("cart.increase", { name: item.name })}
                    onClick={() => updateQuantity(cartLineKey(item), item.quantity + 1)}
                    disabled={isSubmitting}
                    className="h-12 w-12 rounded-r-xl text-2xl leading-none hover:bg-surface-raised disabled:opacity-40"
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => removeItem(cartLineKey(item))}
                  disabled={isSubmitting}
                  className="min-h-11 rounded-lg px-2 text-body text-tertiary underline-offset-4 hover:text-destructive hover:underline disabled:opacity-40"
                >
                  {t("cart.remove")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-8 flex items-baseline justify-between border-t border-border pt-5">
        <div className="text-lg font-medium">{t("cart.total")}</div>
        <div className="font-mono text-2xl font-semibold tabular-nums">{money(total)}</div>
      </div>

      {/* Contacto: el correo de la cuenta se completa solo. */}
      <div className="mt-8 border-t border-border pt-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-body-lg font-semibold">{t("cart.contact")}</h2>
          {prefilled && (
            <span className="rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
              {t("cart.prefilled")}
            </span>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="block sm:col-span-2">
            <label htmlFor="cart-email" className="mb-1 block text-body font-medium text-primary">
              {t("cart.email")}
            </label>
            <input
              id="cart-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("cart.emailPlaceholder")}
              autoComplete="email"
              aria-describedby="cart-email-help"
              className="h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-body text-primary placeholder:text-muted focus:border-primary focus:outline-2 focus:outline-offset-1 focus:outline-[var(--um-brand)]"
            />
            <span id="cart-email-help" className="mt-1 block text-sm text-tertiary">
              {t("cart.emailHelp")}
            </span>
          </div>
          <label htmlFor="cart-name" className="block">
            <span className="mb-1 block text-body font-medium text-primary">{t("cart.fullName")}</span>
            <input
              id="cart-name"
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder={t("cart.namePlaceholder")}
              autoComplete="name"
              className="h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-body text-primary placeholder:text-muted focus:border-primary focus:outline-2 focus:outline-offset-1 focus:outline-[var(--um-brand)]"
            />
          </label>
          <label htmlFor="cart-doc" className="block">
            <span className="mb-1 block text-body font-medium text-primary">{t("cart.doc")}</span>
            <input
              id="cart-doc"
              type="text"
              inputMode="numeric"
              value={docNumber}
              onChange={(event) => setDocNumber(event.target.value)}
              placeholder={t("cart.docPlaceholder")}
              className="h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-body text-primary placeholder:text-muted focus:border-primary focus:outline-2 focus:outline-offset-1 focus:outline-[var(--um-brand)]"
            />
          </label>
        </div>
        <p className="mt-2 text-sm text-tertiary">{t("cart.holdNote")}</p>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={handleOpenConfirmation}
          disabled={isSubmitting}
          className="min-h-14 flex-1 rounded-xl bg-brand text-body-lg font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? t("cart.creating") : t("cart.confirmCta")}
        </button>
        <Link
          href="/"
          className="flex min-h-14 flex-1 items-center justify-center rounded-xl border border-border-strong text-body font-medium hover:bg-surface-raised"
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
        className="mt-5 min-h-11 text-sm text-tertiary underline-offset-4 hover:text-destructive hover:underline disabled:opacity-40"
      >
        {t("cart.clear")}
      </button>

      <p className="mt-4 text-sm text-tertiary">
        <Link
          href="/libro-de-reclamaciones"
          className="underline underline-offset-4 hover:text-primary"
        >
          {t("cart.complaintsLink")}
        </Link>
      </p>

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
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-border bg-surface p-5 sm:max-w-lg sm:rounded-3xl sm:p-7"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[3px] text-muted">
                  {t("cart.confirmKicker")}
                </div>
                <h2 id="checkout-confirm-title" className="mt-1 text-2xl font-semibold tracking-tight">
                  {t("cart.confirmSafetyTitle")}
                </h2>
                <p className="mt-1.5 text-sm text-secondary">{t("cart.confirmSafetyBody")}</p>
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

            {/* Resumen de una línea: el detalle ya está detrás, en el carrito. */}
            <div className="mt-5 rounded-2xl border border-border bg-background p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-secondary">
                  {t("cart.summaryCount", { count: summary.itemCount })}
                </span>
                <span className="font-mono text-2xl font-semibold tabular-nums">
                  {money(summary.total)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">{t("cart.pricesServer")}</p>
            </div>

            <fieldset className="mt-5">
              <legend className="text-body font-semibold">{t("cart.payment")}</legend>
              <div className="mt-2 space-y-2">
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                    effectivePaymentChoice === "yape"
                      ? "border-brand bg-surface-raised"
                      : "border-border hover:bg-surface-raised/60"
                  }`}
                >
                  <input
                    type="radio"
                    name="payment"
                    value="yape"
                    checked={effectivePaymentChoice === "yape"}
                    onChange={() => setPaymentChoice("yape")}
                    className="mt-1 h-4 w-4 accent-[var(--um-brand)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-medium">{t("cart.paymentYape")}</span>
                    <span className="mt-0.5 block text-xs text-tertiary">
                      {t("cart.paymentYapeHint")}
                    </span>
                  </span>
                </label>

                <label
                  className={`flex items-start gap-3 rounded-xl border p-3 ${
                    !cashAvailable
                      ? "cursor-not-allowed border-border opacity-60"
                      : effectivePaymentChoice === "cash"
                        ? "cursor-pointer border-brand bg-surface-raised"
                        : "cursor-pointer border-border hover:bg-surface-raised/60"
                  }`}
                >
                  <input
                    type="radio"
                    name="payment"
                    value="cash"
                    checked={effectivePaymentChoice === "cash"}
                    disabled={!cashAvailable}
                    onChange={() => setPaymentChoice("cash")}
                    className="mt-1 h-4 w-4 accent-[var(--um-brand)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-medium">{t("cart.paymentCash")}</span>
                    <span className="mt-0.5 block text-xs text-tertiary">
                      {!loggedIn
                        ? t("cart.paymentCashAccount")
                        : !paymentInfo?.cash
                          ? t("cart.paymentCashUnavailable")
                          : t("cart.paymentCashHint")}
                    </span>
                    {!loggedIn && (
                      <Link
                        href="/ingresar?next=/cart"
                        className="mt-1 inline-block text-xs font-medium text-primary underline underline-offset-2"
                      >
                        {t("cart.signIn")}
                      </Link>
                    )}
                  </span>
                </label>
              </div>
            </fieldset>

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
                className="min-h-12 flex-1 rounded-xl border border-border-strong font-medium hover:bg-surface-raised disabled:opacity-40"
              >
                {t("cart.backToCart")}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={() => void handleConfirmPurchase()}
                disabled={isSubmitting}
                className="min-h-12 flex-1 rounded-xl bg-brand font-semibold text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? t("cart.creating") : t("cart.confirmSafetyButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
