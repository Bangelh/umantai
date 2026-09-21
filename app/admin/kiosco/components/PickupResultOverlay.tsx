'use client';

/**
 * Resultado de un intento de entrega, a pantalla completa.
 *
 * Ocupa TODA la pantalla y hay que cerrarlo a propósito: si el aviso fuese un cartelito
 * en una esquina, la operaria podría seguir tipeando otro PIN sin haber visto si la
 * entrega se registró o no. El verde y el rojo son pantallas completas justamente para
 * que sea imposible confundirlos a un metro de distancia.
 *
 * El botón tiene foco automático: con un lector de pantalla o un teclado conectado, la
 * acción "continuar" ya está seleccionada sin tener que buscarla.
 */

export interface PickupOutcome {
  ok: boolean;
  /** Texto del servidor, ya en lenguaje de mostrador. */
  message: string;
  orderNumber: string | null;
  lockerSlot: string | null;
  customerName: string | null;
  itemSummary: string | null;
}

interface PickupResultOverlayProps {
  outcome: PickupOutcome;
  onClose: () => void;
}

export function PickupResultOverlay({ outcome, onClose }: PickupResultOverlayProps) {
  const { ok } = outcome;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={ok ? 'Entrega registrada' : 'Entrega no registrada'}
      className={
        'fixed inset-0 z-50 flex flex-col overflow-y-auto p-6 ' +
        (ok ? 'bg-emerald-800' : 'bg-red-900')
      }
    >
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6">
        <div className="text-center">
          <div
            aria-hidden="true"
            className="text-[7rem] leading-none font-bold text-white"
          >
            {ok ? '✓' : '✕'}
          </div>
          <h2 className="mt-2 text-6xl font-bold tracking-tight text-white">
            {ok ? 'ENTREGAR' : 'NO ENTREGAR'}
          </h2>
        </div>

        <p role="alert" className="text-center text-3xl leading-snug text-white">
          {outcome.message}
        </p>

        <dl className="rounded-3xl bg-black/30 p-6 text-white">
          {outcome.orderNumber && (
            <div className="flex flex-col gap-1 border-b border-white/25 py-4 first:pt-0">
              <dt className="text-xl uppercase tracking-widest text-white/80">Pedido</dt>
              <dd className="font-mono text-5xl font-bold">{outcome.orderNumber}</dd>
            </div>
          )}

          {outcome.customerName && (
            <div className="flex flex-col gap-1 border-b border-white/25 py-4">
              <dt className="text-xl uppercase tracking-widest text-white/80">Cliente</dt>
              <dd className="text-3xl font-semibold">{outcome.customerName}</dd>
            </div>
          )}

          {outcome.itemSummary && (
            <div className="flex flex-col gap-1 border-b border-white/25 py-4">
              <dt className="text-xl uppercase tracking-widest text-white/80">Qué entregar</dt>
              <dd className="text-3xl leading-snug">{outcome.itemSummary}</dd>
            </div>
          )}

          {outcome.lockerSlot && (
            <div className="flex flex-col gap-1 py-4 last:pb-0">
              <dt className="text-xl uppercase tracking-widest text-white/80">Casillero</dt>
              <dd className="text-5xl font-bold">{outcome.lockerSlot}</dd>
            </div>
          )}
        </dl>

        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="min-h-[112px] w-full select-none rounded-3xl border-4 border-white bg-white text-4xl font-bold text-neutral-950 touch-manipulation active:bg-white/80"
        >
          LISTO
        </button>
      </div>
    </div>
  );
}

export default PickupResultOverlay;
