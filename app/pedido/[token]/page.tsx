import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrderByPublicToken } from "@/lib/commerce.server";
import type { FulfillmentType, OrderStatus, OrderWithItems } from "@/lib/commerce";

/**
 * /pedido/[token] — estado público del pedido.
 *
 * `token` es `orders.public_token`, no el UUID interno: es el enlace que se le puede
 * pasar al comprador invitado sin filtrar identificadores de la base.
 *
 * NO se lee vía `fetch('/api/orders?token=...')`. Desde un Server Component eso obliga
 * a construir una URL absoluta (y con `NEXT_PUBLIC_SERVER_URL` un preview de Vercel
 * terminaría pegándole a producción). Llamamos a la misma capa de datos que usa el
 * endpoint —mismo resultado, sin salto HTTP y sin depender del host—.
 * El GET sigue disponible para cuando necesites polling desde el cliente.
 */

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "Awaiting payment",
  confirmed: "Payment confirmed",
  preparing: "Being prepared",
  ready_for_pickup: "Ready for pickup",
  picked_up: "Picked up",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Reservation expired",
  refunded: "Refunded",
};

const STATUS_TONES: Record<OrderStatus, string> = {
  pending_payment: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  confirmed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  preparing: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  ready_for_pickup: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  picked_up: "border-white/20 bg-white/5 text-white/80",
  out_for_delivery: "border-white/20 bg-white/5 text-white/80",
  delivered: "border-white/20 bg-white/5 text-white/80",
  completed: "border-white/20 bg-white/5 text-white/80",
  cancelled: "border-red-500/30 bg-red-500/10 text-red-300",
  expired: "border-red-500/30 bg-red-500/10 text-red-300",
  refunded: "border-red-500/30 bg-red-500/10 text-red-300",
};

const FULFILLMENT_LABELS: Record<FulfillmentType, string> = {
  pickup_locker: "Pickup at locker",
  pickup_counter: "Pickup at counter",
  delivery: "Home delivery",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Lima",
  }).format(date);
}

function Notice({ order }: { order: OrderWithItems }) {
  if (order.status === "pending_payment") {
    const expiresAt = formatDateTime(order.reservationExpiresAt);
    return (
      <p className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-200">
        We are holding your items{expiresAt ? ` until ${expiresAt}` : ""}. They are released back
        to the store if the payment is not completed in time.
      </p>
    );
  }

  if (order.status === "cancelled" || order.status === "expired") {
    return (
      <p className="mt-6 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-200">
        This order is no longer active. Nothing was charged and the stock was released.
      </p>
    );
  }

  if (order.status === "ready_for_pickup" && order.lockerCode) {
    return (
      <p className="mt-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-200">
        Your order is ready at <span className="font-semibold">{order.lockerCode}</span>. Bring your
        pickup code.
      </p>
    );
  }

  return null;
}

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  // En esta versión de Next `params` es una Promise: hay que esperarla.
  const { token } = await params;

  // Validación barata: evita mandar basura a Postgres con un cast ::uuid.
  if (!UUID_PATTERN.test(token)) notFound();

  let order: OrderWithItems | null;

  try {
    order = await getOrderByPublicToken(token);
  } catch (error) {
    // Típicamente: base de datos sin configurar en un preview deploy.
    console.error("Order page: could not load order", error);
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center px-8">
        <div className="max-w-md text-center">
          <h1 className="text-3xl tracking-tight mb-4">We could not load this order</h1>
          <p className="text-white/60 mb-8">
            This is usually temporary. Please try again in a moment.
          </p>
          <Link
            href="/products"
            className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-black font-medium hover:bg-white/90"
          >
            Back to the collection
          </Link>
        </div>
      </div>
    );
  }

  if (!order) notFound();

  const statusLabel = STATUS_LABELS[order.status];
  const statusTone = STATUS_TONES[order.status];
  const fulfillmentLabel = FULFILLMENT_LABELS[order.fulfillmentType];
  const placedAt = formatDateTime(order.createdAt);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-3xl mx-auto px-8 py-12">
        <Link href="/products" className="text-sm text-white/50 hover:text-white/80">
          ← Continue shopping
        </Link>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <h1 className="text-4xl sm:text-5xl tracking-tighter font-semibold">
            {order.orderNumber}
          </h1>
          <span className={`rounded-full border px-4 py-1 text-sm ${statusTone}`}>{statusLabel}</span>
        </div>

        <p className="mt-3 text-sm text-white/50">
          {placedAt ? `Placed on ${placedAt}` : "Just placed"}
          {order.itemCount > 0
            ? ` · ${order.itemCount} item${order.itemCount === 1 ? "" : "s"}`
            : ""}
        </p>

        <Notice order={order} />

        {/* Líneas del pedido — snapshot inmutable: estos precios y nombres quedaron
            congelados al momento de comprar. */}
        <div className="mt-10 space-y-4">
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-5 border border-white/10 bg-neutral-900 p-5 rounded-3xl"
            >
              <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex-shrink-0 flex items-center justify-center text-lg font-semibold text-white/60">
                {item.productName.slice(0, 1).toUpperCase()}
              </div>

              <div className="flex-1 min-w-0">
                {item.productBrand && (
                  <div className="text-xs text-white/50">{item.productBrand}</div>
                )}
                <div className="font-semibold tracking-tight truncate">{item.productName}</div>
                {item.variantKey && (
                  <div className="text-xs text-white/40 mt-1">
                    {Object.entries(item.variant)
                      .filter(([, value]) => Boolean(value))
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" · ")}
                  </div>
                )}
              </div>

              <div className="text-right">
                <div className="font-mono">{formatMoney(item.lineTotal, order.currency)}</div>
                <div className="text-xs text-white/40 mt-1">
                  {item.quantity} × {formatMoney(item.unitPrice, order.currency)}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Totales */}
        <div className="mt-10 border-t border-white/10 pt-6 space-y-2 text-sm">
          <div className="flex justify-between text-white/70">
            <span>Subtotal</span>
            <span className="font-mono">{formatMoney(order.subtotal, order.currency)}</span>
          </div>

          {order.discountTotal > 0 && (
            <div className="flex justify-between text-white/70">
              <span>Discount</span>
              <span className="font-mono">−{formatMoney(order.discountTotal, order.currency)}</span>
            </div>
          )}

          {order.taxTotal > 0 && (
            <div className="flex justify-between text-white/70">
              <span>Tax</span>
              <span className="font-mono">{formatMoney(order.taxTotal, order.currency)}</span>
            </div>
          )}

          {order.shippingTotal > 0 && (
            <div className="flex justify-between text-white/70">
              <span>Shipping</span>
              <span className="font-mono">{formatMoney(order.shippingTotal, order.currency)}</span>
            </div>
          )}

          <div className="flex justify-between items-baseline border-t border-white/10 pt-4 text-xl">
            <span>Total</span>
            <span className="font-mono tracking-tighter">
              {formatMoney(order.total, order.currency)}
            </span>
          </div>
        </div>

        {/* Entrega y contacto */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <div className="border border-white/10 bg-neutral-900 rounded-3xl p-5">
            <div className="text-xs tracking-widest text-white/50 mb-2">FULFILLMENT</div>
            <div className="font-medium">{fulfillmentLabel}</div>
            {order.lockerCode && (
              <div className="text-sm text-white/60 mt-1">Location: {order.lockerCode}</div>
            )}
          </div>

          <div className="border border-white/10 bg-neutral-900 rounded-3xl p-5">
            <div className="text-xs tracking-widest text-white/50 mb-2">CONTACT</div>
            <div className="font-medium break-all">{order.contactEmail}</div>
            {order.contactPhone && (
              <div className="text-sm text-white/60 mt-1">{order.contactPhone}</div>
            )}
          </div>
        </div>

        {order.customerNote && (
          <div className="mt-4 border border-white/10 bg-neutral-900 rounded-3xl p-5">
            <div className="text-xs tracking-widest text-white/50 mb-2">YOUR NOTE</div>
            <p className="text-sm text-white/80 whitespace-pre-wrap">{order.customerNote}</p>
          </div>
        )}

        <p className="mt-10 text-xs text-white/40">
          Save this link: it is your order reference. Payment is wired up in the next phase.
        </p>
      </div>
    </div>
  );
}
