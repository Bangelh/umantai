'use client';

import type { KioskOrderSummary } from '@/lib/commerce';

/**
 * Pedidos listos para entregar.
 *
 * Esta lista es CONTEXTO, no la acción: la entrega la dispara el PIN que dicta el
 * cliente, no un toque en una fila. Por eso las tarjetas no tienen botón de "entregar":
 * un botón así permitiría entregar el pedido equivocado de un solo toque, y el PIN
 * dejaría de ser el control que prueba que quien retira es quien compró.
 *
 * El PIN NUNCA aparece acá (el servidor tampoco lo manda).
 */

interface ReadyOrdersListProps {
  orders: KioskOrderSummary[];
  /** `true` cuando la última actualización falló: lo que se ve puede estar viejo. */
  isStale: boolean;
}

function formatExpiry(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Lima',
  }).format(date);
}

export function ReadyOrdersList({ orders, isStale }: ReadyOrdersListProps) {
  if (orders.length === 0) {
    return (
      <div className="rounded-3xl border-2 border-dashed border-white/20 bg-neutral-900 p-8 text-center">
        <p className="text-3xl font-semibold text-white">No hay pedidos esperando retiro</p>
        <p className="mt-2 text-2xl text-neutral-300">
          Cuando marques un pedido como listo, aparece acá.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-3xl font-semibold text-white">
          Listos para entregar
          <span className="ml-3 rounded-full bg-white px-4 py-1 text-2xl font-bold text-neutral-950">
            {orders.length}
          </span>
        </h2>
        {isStale && (
          <p className="text-xl font-semibold text-amber-300">
            ⚠ La lista puede estar desactualizada
          </p>
        )}
      </div>

      <ul className="space-y-3">
        {orders.map((order) => {
          const expiry = formatExpiry(order.codeExpiresAt);

          return (
            <li
              key={order.orderId}
              className="rounded-3xl border-2 border-white/15 bg-neutral-900 p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-mono text-4xl font-bold text-white">{order.orderNumber}</span>
                {order.lockerSlot && (
                  <span className="rounded-xl bg-sky-900/70 px-4 py-1 text-2xl font-semibold text-sky-100">
                    Casillero {order.lockerSlot}
                  </span>
                )}
              </div>

              {order.customerName && (
                <p className="mt-2 text-3xl font-semibold text-white">{order.customerName}</p>
              )}

              <p className="mt-2 text-2xl leading-snug text-neutral-200">
                {order.itemSummary ?? `${order.itemCount} producto(s)`}
              </p>

              {expiry && (
                <p className="mt-2 text-xl text-neutral-400">El PIN vence el {expiry}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ReadyOrdersList;
