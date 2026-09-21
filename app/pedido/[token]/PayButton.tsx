"use client";

import { useState } from "react";
import { toast } from "sonner";

/**
 * Botón "Pay with Mercado Pago" de la página de estado del pedido.
 *
 * ─── POR QUÉ NO ES UN <a href="..."> ─────────────────────────────────────────
 * El link de pago no existe hasta que el servidor crea la Preference (y hay que
 * crearla con el access token, que jamás puede llegar al navegador). Así que el
 * clic hace un POST a /api/payments/preference y recién después redirige.
 *
 * El POST no manda el monto: solo el token público del pedido. El precio lo resuelve
 * el servidor desde Postgres — si el navegador pudiera fijar el monto, cualquiera
 * pagaría S/ 1.00 por un iPhone.
 */
interface PayButtonProps {
  /** `orders.public_token` — lo que identifica al pedido en el servidor. */
  publicToken: string;
  /** Total ya formateado en el servidor (ej. "S/ 4,299.00"). */
  amountLabel: string;
}

export function PayButton({ publicToken, amountLabel }: PayButtonProps) {
  const [isRedirecting, setIsRedirecting] = useState(false);

  const handlePay = async () => {
    if (isRedirecting) return;
    setIsRedirecting(true);

    try {
      const response = await fetch("/api/payments/preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: publicToken }),
      });

      const payload = await response.json().catch(() => null);
      const initPoint = typeof payload?.initPoint === "string" ? payload.initPoint : null;

      if (!response.ok || !initPoint) {
        toast.error(payload?.error ?? "We could not open Mercado Pago. Please try again.");
        setIsRedirecting(false);
        return;
      }

      // Navegación completa a propósito: el checkout se completa en el dominio de
      // Mercado Pago, no dentro de la app. No usamos router.push().
      window.location.assign(initPoint);
    } catch {
      toast.error("Network error. Your payment was not started.");
      setIsRedirecting(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handlePay}
        disabled={isRedirecting}
        className="inline-flex h-14 w-full items-center justify-center rounded-2xl bg-[#009EE3] px-8 font-medium text-white transition-colors hover:bg-[#0089c7] disabled:cursor-not-allowed disabled:bg-[#009EE3]/60 sm:w-auto"
      >
        {isRedirecting ? "Opening Mercado Pago…" : `Pay ${amountLabel} with Mercado Pago`}
      </button>
      <p className="mt-3 text-xs text-white/40">
        You will be redirected to Mercado Pago to finish the payment.
      </p>
    </div>
  );
}

export default PayButton;
