import Link from "next/link";
import { notFound } from "next/navigation";
import { expireStaleOrders, getIssuedPickupCode, getOrderByPublicToken } from "@/lib/commerce.server";
import {
  evaluateOrderPayability,
  type FulfillmentType,
  type OrderStatus,
  type OrderWithItems,
  type PickupCode,
} from "@/lib/commerce";
import { PayButton } from "./PayButton";

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
 *
 * ─── AQUÍ VIVE EL PIN DEL CLIENTE ────────────────────────────────────────────
 * Cuando el pedido pasa a `ready_for_pickup`, esta página es el ÚNICO lugar donde el
 * comprador ve su PIN (el kiosco nunca lo devuelve: es la operaria quien lo tipea, y el
 * código tiene que probar algo). Por eso se lee con `getIssuedPickupCode()` —que
 * descarta los PIN vencidos— y se renderiza en grande, tipo ticket.
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

/**
 * Estados de regreso del checkout de Mercado Pago (`back_urls`).
 *
 * `?pago=exitoso` NO significa "pago acreditado": significa que MP nos devolvió al
 * comprador por la URL de pago aprobado. La verdad la dice el pedido cuando llega la
 * confirmación desde MP, no el query param.
 */
type PaymentReturnFlag = "exitoso" | "pendiente" | "fallido";

const PAYMENT_RETURN_NOTICES: Record<PaymentReturnFlag, { tone: string; message: string }> = {
  exitoso: {
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    message:
      "Mercado Pago approved your payment. We are confirming it against this order — if the status has not changed yet, check again in a few seconds.",
  },
  pendiente: {
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    message:
      "Your payment is pending. Yape, Plin and other methods can take a few minutes to confirm; the order updates as soon as Mercado Pago reports it.",
  },
  fallido: {
    tone: "border-red-500/30 bg-red-500/10 text-red-200",
    message:
      "The payment was not completed and nothing was charged. You can try again with another payment method.",
  },
};

function readPaymentReturnFlag(value: string | string[] | undefined): PaymentReturnFlag | null {
  const flag = Array.isArray(value) ? value[0] : value;
  if (flag === "exitoso" || flag === "pendiente" || flag === "fallido") return flag;
  return null;
}

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

function Notice({ order, hasPickupCode }: { order: OrderWithItems; hasPickupCode: boolean }) {
  if (order.status === "pending_payment") {
    const expiresAt = formatDateTime(order.reservationExpiresAt);

    // El reaper puede no haber pasado todavía: el pedido sigue en `pending_payment`
    // aunque la reserva ya venció y el stock volvió a estar disponible.
    if (evaluateOrderPayability(order) !== "payable") {
      return (
        <p className="mt-6 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-200">
          The stock reservation for this order expired
          {expiresAt ? ` on ${expiresAt}` : ""}. Nothing was charged. Start the checkout
          again to reserve the items.
        </p>
      );
    }

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

  if (order.status === "ready_for_pickup") {
    // Con PIN vivo, el ticket de abajo dice todo (ubicación, vigencia e instrucción):
    // repetirlo acá sería ruido.
    if (hasPickupCode) return null;

    // Sin PIN vivo —venció a los 7 días, ya se usó o se revocó— el comprador vería
    // "Ready for pickup" y ningún código. Hay que decirle que no venga y que pregunte.
    return (
      <p className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-200">
        Your order is ready{order.lockerCode ? ` at ${order.lockerCode}` : ""}, but its pickup code is
        no longer valid. Contact the store before coming so they can issue a new one.
      </p>
    );
  }

  return null;
}

/**
 * Ticket de retiro: lo único que el comprador necesita mirar cuando llega a la tienda.
 *
 * El PIN se muestra EN CLARO y en dígitos separados. No es un descuido: el comprador
 * tiene que poder leerlo o dictarlo en voz alta a la operaria, y esconderlo no protegería
 * nada (quien tiene el enlace ya tiene el pedido).
 */
function PickupCodeTicket({ order, code }: { order: OrderWithItems; code: PickupCode }) {
  const expiresAt = formatDateTime(code.expiresAt);
  const location = code.lockerSlot
    ? `Locker ${code.lockerSlot}`
    : code.lockerCode ?? order.lockerCode ?? "Store counter";

  return (
    <section
      aria-labelledby="pickup-code-heading"
      className="mt-6 rounded-3xl border-2 border-emerald-400/60 bg-emerald-500/10 px-6 pt-6 pb-0 overflow-hidden"
    >
      <p id="pickup-code-heading" className="text-center text-xs tracking-[0.3em] text-emerald-300">
        YOUR PICKUP CODE
      </p>

      {/* Los dígitos se anuncian una sola vez y de corrido: un lector de pantalla no
          debería leer "uno, guion, dos..." seis casillas sueltas. */}
      <p className="sr-only">Your pickup code is {code.code.split("").join(" ")}.</p>
      <div aria-hidden="true" className="mt-5 flex justify-center gap-2 sm:gap-3">
        {code.code.split("").map((digit, index) => (
          <span
            key={`${index}-${digit}`}
            className="w-12 sm:w-16 rounded-2xl bg-neutral-950/70 py-4 text-center font-mono text-4xl sm:text-5xl font-bold tabular-nums text-white"
          >
            {digit}
          </span>
        ))}
      </div>

      <p className="mt-5 text-center text-sm text-emerald-100">
        Show this code at the store. The operator types it in to hand over your order.
      </p>

      <dl className="mt-6 -mx-6 grid grid-cols-2 gap-px border-t-2 border-dashed border-emerald-400/40 bg-emerald-400/30 text-center">
        <div className="bg-neutral-950/80 px-4 py-4">
          <dt className="text-[11px] tracking-widest text-white/50">PICK UP AT</dt>
          <dd className="mt-1 font-semibold break-words">{location}</dd>
        </div>
        <div className="bg-neutral-950/80 px-4 py-4">
          <dt className="text-[11px] tracking-widest text-white/50">CODE VALID UNTIL</dt>
          <dd className="mt-1 font-semibold">{expiresAt ?? "Ask the store"}</dd>
        </div>
      </dl>
    </section>
  );
}

export default async function OrderStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ pago?: string | string[] }>;
}) {
  // En esta versión de Next `params` y `searchParams` son Promises: hay que esperarlas.
  const { token } = await params;
  const { pago } = await searchParams;

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

  // ── Expiración dirigida: el estado que se muestra tiene que ser el real ─────
  // El reaper ya no corre cada minuto (Vercel Hobby sólo admite un cron diario), así
  // que el pedido puede quedarse en `pending_payment` con la reserva ya vencida. Cuando
  // eso pasa, esta visita es el momento de soltar el stock y releer el pedido: la
  // pantalla muestra `expired` (lo que de verdad ocurrió) en vez de un `pending_payment`
  // que ya no es cierto.
  //
  // Se usa el MISMO motor que el cron (`expire_stale_orders`), sólo libera reservas
  // realmente vencidas (reloj de Postgres) y es idempotente: recargar la página no
  // vuelve a liberar nada ni suelta una reserva válida antes de tiempo.
  if (order.status === "pending_payment" && evaluateOrderPayability(order) !== "payable") {
    try {
      const expired = await expireStaleOrders();
      // Sólo se relee si el barrido cambió algo: si no, el pedido sigue igual.
      if (expired > 0) order = (await getOrderByPublicToken(token)) ?? order;
    } catch (error) {
      // Degradación: si el barrido falla, la página igual avisa que la reserva venció.
      // Una tarea de mantenimiento no debe tumbar la pantalla del comprador.
      console.error("Order page: no se pudieron expirar reservas vencidas", error);
    }
  }

  // Sólo se consulta el PIN cuando el pedido puede tener uno: una query de más en
  // cada visita a un pedido impago sería gratis de escribir y de pagar igual.
  // `getIssuedPickupCode()` ya descarta los códigos vencidos o canjeados.
  let pickupCode: PickupCode | null = null;
  if (order.status === "ready_for_pickup") {
    try {
      pickupCode = await getIssuedPickupCode(order.id);
    } catch (error) {
      // El pedido ya se cargó: un fallo acá degrada la pantalla (sin ticket) en vez
      // de tumbar la página entera.
      console.error("Order page: could not load the pickup code", error);
    }
  }

  const statusLabel = STATUS_LABELS[order.status];
  const statusTone = STATUS_TONES[order.status];
  const fulfillmentLabel = FULFILLMENT_LABELS[order.fulfillmentType];
  const placedAt = formatDateTime(order.createdAt);

  // Misma regla que aplica el endpoint de pago (una sola definición, en lib/commerce.ts).
  const payability = evaluateOrderPayability(order);
  const canPay = payability === "payable";

  // El aviso de regreso solo se muestra si el pago sigue pendiente: si el pedido ya
  // está confirmado, el badge de estado cuenta la historia y el aviso sobra.
  const returnFlag = readPaymentReturnFlag(pago);
  const returnNotice = returnFlag && order.status === "pending_payment" ? PAYMENT_RETURN_NOTICES[returnFlag] : null;

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

        <Notice order={order} hasPickupCode={pickupCode !== null} />

        {returnNotice && (
          <div className={`mt-4 rounded-2xl border px-5 py-4 text-sm ${returnNotice.tone}`}>
            <p>{returnNotice.message}</p>
            <Link href={`/pedido/${order.publicToken}`} className="mt-2 inline-block underline underline-offset-4">
              Check status again
            </Link>
          </div>
        )}

        {pickupCode && <PickupCodeTicket order={order} code={pickupCode} />}

        {canPay && (
          <div className="mt-6 rounded-3xl border border-white/10 bg-neutral-900 p-6">
            <div className="text-xs tracking-widest text-white/50 mb-2">PAYMENT</div>
            <p className="text-sm text-white/70 mb-5">
              Pay with Yape, Plin, card or your Mercado Pago balance. The stock stays reserved
              for you until the reservation expires.
            </p>
            <PayButton
              publicToken={order.publicToken}
              amountLabel={formatMoney(order.total, order.currency)}
            />
          </div>
        )}

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
          Save this link: it is both your order reference and your payment link.
        </p>
      </div>
    </div>
  );
}
