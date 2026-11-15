'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Cuenta regresiva de la reserva de stock.
 *
 * El pedido nace con 15 minutos de reserva (`RESERVATION_TTL_MINUTES`). El
 * contador se calcula contra `reservationExpiresAt` —el reloj que manda es el de
 * Postgres—, así que recargar la página no reinicia nada.
 *
 * En los últimos 5 minutos cambia a tono de urgencia y late una vez por segundo:
 * el comprador tiene que sentir que el stock se le escapa, no solo leerlo.
 *
 * Al llegar a cero se refresca una sola vez: la página del pedido dispara el
 * barrido perezoso de reservas y muestra el estado real (`expired`).
 */
export function ReservationCountdown({
  expiresAt,
  expiredLabel,
  className,
  urgentClassName,
}: {
  expiresAt: string;
  expiredLabel: string;
  className?: string;
  /** Clases extra cuando quedan 5 minutos o menos. */
  urgentClassName?: string;
}) {
  const router = useRouter();
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const refreshed = useRef(false);

  useEffect(() => {
    const target = Date.parse(expiresAt);
    if (!Number.isFinite(target)) return;

    const tick = () => {
      const next = Math.max(0, target - Date.now());
      setRemainingMs(next);
      if (next === 0 && !refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
    };

    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [expiresAt, router]);

  // Primer render del servidor y del cliente coinciden: hasta montar no hay reloj.
  if (remainingMs === null) {
    return (
      <span className={className} aria-hidden="true">
        --:--
      </span>
    );
  }

  if (remainingMs === 0) {
    return <span className={className}>{expiredLabel}</span>;
  }

  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const urgent = totalSeconds <= 5 * 60;

  return (
    <span
      role="timer"
      aria-live="off"
      className={`${className ?? ''} ${urgent && urgentClassName ? urgentClassName : ''}`}
    >
      {minutes}:{seconds}
    </span>
  );
}
