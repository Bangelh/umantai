import Link from "next/link";
import { notFound } from "next/navigation";
import { expireStaleOrders, getIssuedPickupCode, getOrderByPublicToken } from "@/lib/commerce.server";
import {
  evaluateOrderPayability,
  type OrderStatus,
  type OrderWithItems,
  type PickupCode,
} from "@/lib/commerce";
import { PayButton } from "./PayButton";
import { isOnlinePaymentEnabled } from "@/lib/online-payments";
import { formatMoneyUnits } from "@/lib/format";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/dictionaries";

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

// Tonos con tokens del sistema (funcionan igual en claro y oscuro). Antes usaban
// `text-success` / `bg-surface` fijos: en tema claro quedaban ilegibles.
const STATUS_TONES: Record<OrderStatus, string> = {
  pending_payment: "border-warning/40 bg-warning/10 text-warning",
  confirmed: "border-success/40 bg-success/10 text-success",
  preparing: "border-success/40 bg-success/10 text-success",
  ready_for_pickup: "border-success/40 bg-success/10 text-success",
  picked_up: "border-border-strong bg-surface-raised text-secondary",
  out_for_delivery: "border-border-strong bg-surface-raised text-secondary",
  delivered: "border-border-strong bg-surface-raised text-secondary",
  completed: "border-border-strong bg-surface-raised text-secondary",
  cancelled: "border-destructive/40 bg-destructive/10 text-destructive",
  expired: "border-destructive/40 bg-destructive/10 text-destructive",
  refunded: "border-destructive/40 bg-destructive/10 text-destructive",
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

const PAYMENT_RETURN_TONES: Record<PaymentReturnFlag, string> = {
  exitoso: "border-info/40 bg-info/10 text-info",
  pendiente: "border-warning/40 bg-warning/10 text-warning",
  fallido: "border-destructive/40 bg-destructive/10 text-destructive",
};

function readPaymentReturnFlag(value: string | string[] | undefined): PaymentReturnFlag | null {
  const flag = Array.isArray(value) ? value[0] : value;
  if (flag === "exitoso" || flag === "pendiente" || flag === "fallido") return flag;
  return null;
}

/**
 * Los importes del pedido están en UNIDADES (NUMERIC(10,2)), no en centavos.
 * Se formatean con el helper único de `lib/format.ts` para que el símbolo, el
 * separador y el locale coincidan con el carrito; antes esta página armaba su
 * propio `Intl.NumberFormat` y mostraba "S/ 12.00" donde el carrito decía
 * "S/ 12,00".
 */
function money(amount: number, currency: string): string {
  return formatMoneyUnits(amount, currency, "es");
}

/**
 * ¿Este pago lo aprobó el SIMULADOR QA y no Mercado Pago?
 *
 * Lo marca `orders.metadata.payment.source === 'simulation'` (lo escribe
 * `applyApprovedPayment`). Sin cambios de esquema: reutiliza la estructura de
 * metadata que ya existe. Nunca se muestra como un pago real de Mercado Pago.
 */
function isSimulatedPayment(order: Pick<OrderWithItems, 'metadata'>): boolean {
  const payment = order.metadata?.payment;
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) return false;
  return (payment as Record<string, unknown>).source === "simulation";
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

function Notice({
  order,
  hasPickupCode,
  t,
}: {
  order: OrderWithItems;
  hasPickupCode: boolean;
  t: Translator;
}) {
  if (order.status === "pending_payment") {
    const expiresAt = formatDateTime(order.reservationExpiresAt);

    // El reaper puede no haber pasado todavía: el pedido sigue en `pending_payment`
    // aunque la reserva ya venció y el stock volvió a estar disponible.
    if (evaluateOrderPayability(order) !== "payable") {
      return (
        <p className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-body text-destructive">
          {expiresAt
            ? t("order.notice.expiredReservationAt", { date: expiresAt })
            : t("order.notice.expiredReservation")}
        </p>
      );
    }

    return (
      <p className="mt-6 rounded-2xl border border-warning/40 bg-warning/10 px-5 py-4 text-body text-warning">
        {expiresAt ? t("order.notice.holdingUntil", { date: expiresAt }) : t("order.notice.holding")}
      </p>
    );
  }

  if (order.status === "cancelled" || order.status === "expired") {
    return (
      <p className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-body text-destructive">
        {t("order.notice.inactive")}
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
      <p className="mt-6 rounded-2xl border border-warning/40 bg-warning/10 px-5 py-4 text-body text-warning">
        {order.lockerCode
          ? t("order.notice.readyAt", { location: order.lockerCode })
          : t("order.notice.ready")}
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
function PickupCodeTicket({
  order,
  code,
  t,
}: {
  order: OrderWithItems;
  code: PickupCode;
  t: Translator;
}) {
  const expiresAt = formatDateTime(code.expiresAt);
  const location = code.lockerSlot
    ? t("order.locker", { slot: code.lockerSlot })
    : code.lockerCode ?? order.lockerCode ?? t("order.storeCounter");

  return (
    <section
      aria-labelledby="pickup-code-heading"
      className="mt-6 rounded-3xl border-2 border-success/50 bg-success/10 px-6 pt-6 pb-0 overflow-hidden"
    >
      <p id="pickup-code-heading" className="text-center text-xs tracking-[0.3em] text-success">
        {t("order.pickupKicker")}
      </p>

      {/* Los dígitos se anuncian una sola vez y de corrido: un lector de pantalla no
          debería leer "uno, guion, dos..." seis casillas sueltas. */}
      <p className="sr-only">{t("order.pickupSr", { code: code.code.split("").join(" ") })}</p>
      <div aria-hidden="true" className="mt-5 flex justify-center gap-2 sm:gap-3">
        {code.code.split("").map((digit, index) => (
          <span
            key={`${index}-${digit}`}
            className="w-12 sm:w-16 rounded-2xl bg-background/80 py-4 text-center font-mono text-4xl sm:text-5xl font-bold tabular-nums text-primary"
          >
            {digit}
          </span>
        ))}
      </div>

      <p className="mt-5 text-center text-body text-secondary">
        {t("order.pickupBody")}
      </p>

      <dl className="mt-6 -mx-6 grid grid-cols-2 gap-px border-t-2 border-dashed border-success/40 bg-success/30 text-center">
        <div className="bg-surface px-4 py-4">
          <dt className="text-[11px] tracking-widest text-tertiary">{t("order.pickupAt")}</dt>
          <dd className="mt-1 font-semibold break-words">{location}</dd>
        </div>
        <div className="bg-surface px-4 py-4">
          <dt className="text-[11px] tracking-widest text-tertiary">
            {t("order.pickupValidUntil")}
          </dt>
          <dd className="mt-1 font-semibold">{expiresAt ?? t("order.askStore")}</dd>
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
  const { t } = await getTranslator();

  // Validación barata: evita mandar basura a Postgres con un cast ::uuid.
  if (!UUID_PATTERN.test(token)) notFound();

  let order: OrderWithItems | null;

  try {
    order = await getOrderByPublicToken(token);
  } catch (error) {
    // Típicamente: base de datos sin configurar en un preview deploy.
    console.error("Order page: could not load order", error);
    return (
      <div className="min-h-screen bg-background text-primary flex items-center justify-center px-8">
        <div className="max-w-md text-center">
          <h1 className="text-3xl tracking-tight mb-4">{t("order.loadFailedTitle")}</h1>
          <p className="text-secondary mb-8">{t("order.loadFailedBody")}</p>
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-full bg-brand px-8 text-background font-medium hover:opacity-90"
          >
            {t("order.backToCollection")}
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

  const statusLabel = t(`status.${order.status}` as MessageKey);
  const statusTone = STATUS_TONES[order.status];
  const fulfillmentLabel = t(`order.fulfillment.${order.fulfillmentType}` as MessageKey);
  const placedAt = formatDateTime(order.createdAt);

  // Misma regla que aplica el endpoint de pago (una sola definición, en lib/commerce.ts).
  const payability = evaluateOrderPayability(order);
  const canPay = payability === "payable";
  // Mercado Pago está congelado por decisión del negocio: el pedido se crea y la
  // reserva corre igual, pero no se ofrece cobro online hasta habilitarlo por
  // entorno (ver lib/online-payments.ts).
  const onlinePaymentEnabled = isOnlinePaymentEnabled();
  const simulated = isSimulatedPayment(order);

  // El aviso de regreso solo se muestra si el pago sigue pendiente: si el pedido ya
  // está confirmado, el badge de estado cuenta la historia y el aviso sobra.
  const returnFlag = readPaymentReturnFlag(pago);
  const returnNotice =
    returnFlag && order.status === "pending_payment"
      ? {
          tone: PAYMENT_RETURN_TONES[returnFlag],
          messageKey: `order.return.${returnFlag}` as MessageKey,
        }
      : null;

  return (
    <div className="min-h-screen bg-background text-primary">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 sm:py-10">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center text-body text-secondary underline-offset-4 hover:text-primary hover:underline"
        >
          ← {t("order.continueShopping")}
        </Link>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <h1 className="text-4xl sm:text-5xl tracking-tighter font-semibold">
            {order.orderNumber}
          </h1>
          <span className={`rounded-full border px-4 py-1 text-body ${statusTone}`}>{statusLabel}</span>
          {simulated && (
            <span
              className="rounded-full border border-warning/40 bg-warning/10 px-4 py-1 text-body text-warning"
              title={t("order.simulatedTitle")}
            >
              {t("order.simulatedBadge")}
            </span>
          )}
        </div>

        <p className="mt-3 text-body text-tertiary">
          {placedAt ? t("order.placedOn", { date: placedAt }) : t("order.justPlaced")}
          {order.itemCount > 0
            ? ` · ${t(
                order.itemCount === 1 ? "order.itemCountOne" : "order.itemCountMany",
                { count: order.itemCount },
              )}`
            : ""}
        </p>

        <Notice order={order} hasPickupCode={pickupCode !== null} t={t} />

        {returnNotice && (
          <div className={`mt-4 rounded-2xl border px-5 py-4 text-body ${returnNotice.tone}`}>
            <p>{t(returnNotice.messageKey)}</p>
            <Link href={`/pedido/${order.publicToken}`} className="mt-2 inline-block underline underline-offset-4">
              {t("order.checkAgain")}
            </Link>
          </div>
        )}

        {pickupCode && <PickupCodeTicket order={order} code={pickupCode} t={t} />}

        {canPay && (
          <div
            className={`mt-6 rounded-3xl border p-6 ${
              onlinePaymentEnabled
                ? "border-border bg-surface"
                : "border-warning/40 bg-warning/10"
            }`}
          >
            <div className="text-xs tracking-widest text-tertiary mb-2">
              {t("order.paymentKicker")}
            </div>
            {onlinePaymentEnabled ? (
              <>
                <p className="text-body text-secondary mb-5">{t("order.paymentBody")}</p>
                <PayButton
                  publicToken={order.publicToken}
                  amountLabel={money(order.total, order.currency)}
                />
              </>
            ) : (
              <>
                <p className="text-body font-medium text-warning">
                  {t("order.paymentUnavailableTitle")}
                </p>
                <p className="mt-2 text-body text-secondary">
                  {t("order.paymentUnavailableBody")}
                </p>
              </>
            )}
          </div>
        )}

        {/* Líneas del pedido — snapshot inmutable: estos precios y nombres quedaron
            congelados al momento de comprar. */}
        <div className="mt-10 space-y-4">
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-5 border border-border bg-surface p-5 rounded-3xl"
            >
              <div className="w-16 h-16 rounded-2xl bg-surface-raised flex-shrink-0 flex items-center justify-centertext-body-lg font-semibold text-secondary">
                {item.productName.slice(0, 1).toUpperCase()}
              </div>

              <div className="flex-1 min-w-0">
                {item.productBrand && (
                  <div className="text-xs text-tertiary">{item.productBrand}</div>
                )}
                <div className="font-semibold tracking-tight truncate">{item.productName}</div>
                {item.variantKey && (
                  <div className="text-sm text-tertiary mt-1">
                    {Object.entries(item.variant)
                      .filter(([, value]) => Boolean(value))
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" · ")}
                  </div>
                )}
              </div>

              <div className="text-right">
                <div className="font-mono">{money(item.lineTotal, order.currency)}</div>
                <div className="text-sm text-tertiary mt-1">
                  {item.quantity} × {money(item.unitPrice, order.currency)}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Totales */}
        <div className="mt-10 border-t border-border pt-6 space-y-2 text-base">
          <div className="flex justify-between text-secondary">
            <span>{t("order.subtotal")}</span>
            <span className="font-mono">{money(order.subtotal, order.currency)}</span>
          </div>

          {order.discountTotal > 0 && (
            <div className="flex justify-between text-secondary">
              <span>{t("order.discount")}</span>
              <span className="font-mono">−{money(order.discountTotal, order.currency)}</span>
            </div>
          )}

          {order.taxTotal > 0 && (
            <div className="flex justify-between text-secondary">
              <span>{t("order.tax")}</span>
              <span className="font-mono">{money(order.taxTotal, order.currency)}</span>
            </div>
          )}

          {order.shippingTotal > 0 && (
            <div className="flex justify-between text-secondary">
              <span>{t("order.shipping")}</span>
              <span className="font-mono">{money(order.shippingTotal, order.currency)}</span>
            </div>
          )}

          <div className="flex justify-between items-baseline border-t border-border pt-4 text-xl">
            <span>{t("order.total")}</span>
            <span className="font-mono tracking-tighter">
              {money(order.total, order.currency)}
            </span>
          </div>
        </div>

        {/* Entrega y contacto */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <div className="border border-border bg-surface rounded-3xl p-5">
            <div className="text-xs tracking-widest text-tertiary mb-2">
              {t("order.fulfillment")}
            </div>
            <div className="font-medium">{fulfillmentLabel}</div>
            {order.lockerCode && (
              <div className="text-body text-secondary mt-1">
                {t("order.location", { location: order.lockerCode })}
              </div>
            )}
          </div>

          <div className="border border-border bg-surface rounded-3xl p-5">
            <div className="text-xs tracking-widest text-tertiary mb-2">
              {t("order.contact")}
            </div>
            <div className="font-medium break-all">{order.contactEmail}</div>
            {order.contactPhone && (
              <div className="text-body text-secondary mt-1">{order.contactPhone}</div>
            )}
          </div>
        </div>

        {order.customerNote && (
          <div className="mt-4 border border-border bg-surface rounded-3xl p-5">
            <div className="text-xs tracking-widest text-tertiary mb-2">
              {t("order.yourNote")}
            </div>
            <p className="text-body text-secondary whitespace-pre-wrap">{order.customerNote}</p>
          </div>
        )}

        <p className="mt-10 text-sm text-tertiary">
          {t("order.saveLink")}
        </p>

        <p className="mt-3 text-xs">
          <Link
            href="/libro-de-reclamaciones"
            className="text-secondary underline underline-offset-4 hover:text-primary"
          >
            {t("order.complaintsLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}
