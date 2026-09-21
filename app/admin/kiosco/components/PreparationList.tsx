'use client';

import { useState } from 'react';
import type { KioskOrderSummary } from '@/lib/commerce';

/**
 * Pedidos pagados que todavía no están preparados.
 *
 * Acá sí hay UN botón por pedido, y es a propósito: esto no entrega nada, sólo avisa
 * que la mercadería ya está en el casillero y dispara la emisión del PIN. El riesgo de
 * equivocarse de fila es bajo (todavía no hay nada físico que sacar) y la alternativa
 * —que la operaria no pueda preparar nada— dejaría el kiosco inservible.
 *
 * El campo de casillero es OPCIONAL y numérico: si escribir en una tablet le resulta
 * incómodo, puede marcar el pedido listo igual y anotar el casillero en otro momento.
 */

interface PreparationListProps {
  orders: KioskOrderSummary[];
  /** Id del pedido que se está preparando ahora mismo (para bloquear dobles toques). */
  busyOrderId: string | null;
  onMarkReady: (orderId: string, lockerSlot: string | null) => void;
}

function PreparationCard({
  order,
  isBusy,
  disabled,
  onMarkReady,
}: {
  order: KioskOrderSummary;
  isBusy: boolean;
  disabled: boolean;
  onMarkReady: (orderId: string, lockerSlot: string | null) => void;
}) {
  const [slot, setSlot] = useState('');

  return (
    <li className="rounded-3xl border-2 border-white/15 bg-neutral-900 p-5">
      <span className="font-mono text-4xl font-bold text-white">{order.orderNumber}</span>

      {order.customerName && (
        <p className="mt-2 text-3xl font-semibold text-white">{order.customerName}</p>
      )}

      <p className="mt-2 text-2xl leading-snug text-neutral-200">
        {order.itemSummary ?? `${order.itemCount} producto(s)`}
      </p>

      <label className="mt-4 block text-2xl text-neutral-200">
        Número de casillero (opcional)
        <input
          type="text"
          inputMode="numeric"
          value={slot}
          onChange={(event) => setSlot(event.target.value.replace(/[^0-9A-Za-z-]/g, '').slice(0, 8))}
          disabled={disabled}
          placeholder="Ej. 12"
          className="mt-2 h-20 w-full rounded-2xl border-2 border-white/25 bg-neutral-950 px-5 text-3xl text-white placeholder:text-neutral-600 focus:border-sky-400 focus:outline-none"
        />
      </label>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onMarkReady(order.orderId, slot.trim() ? slot.trim() : null)}
        className="mt-4 min-h-[96px] w-full select-none rounded-2xl border-2 border-white bg-white text-3xl font-bold text-neutral-950 touch-manipulation active:bg-white/80 disabled:opacity-50"
      >
        {isBusy ? 'Preparando…' : 'YA ESTÁ EN EL CASILLERO'}
      </button>
    </li>
  );
}

export function PreparationList({ orders, busyOrderId, onMarkReady }: PreparationListProps) {
  if (orders.length === 0) {
    return (
      <div className="rounded-3xl border-2 border-dashed border-white/20 bg-neutral-900 p-8 text-center">
        <p className="text-3xl font-semibold text-white">No hay pedidos por preparar</p>
        <p className="mt-2 text-2xl text-neutral-300">
          Acá aparecen los pedidos ya pagados que todavía no están en un casillero.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-3 text-3xl font-semibold text-white">
        Pagados, por preparar
        <span className="ml-3 rounded-full bg-white px-4 py-1 text-2xl font-bold text-neutral-950">
          {orders.length}
        </span>
      </h2>

      <ul className="space-y-3">
        {orders.map((order) => (
          <PreparationCard
            key={order.orderId}
            order={order}
            isBusy={busyOrderId === order.orderId}
            // Mientras un pedido se prepara, se bloquean todos: evita dos toques
            // simultáneos y el estado confuso de "¿cuál de los dos pasó?".
            disabled={busyOrderId !== null}
            onMarkReady={onMarkReady}
          />
        ))}
      </ul>
    </div>
  );
}

export default PreparationList;
