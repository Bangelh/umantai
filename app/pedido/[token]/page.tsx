import Link from "next/link";
import { notFound } from "next/navigation";
import { expireStaleOrders, getIssuedPickupCode, getOrderByPublicToken } from "@/lib/commerce.server";
import {
  evaluateOrderPayability,
  type OrderWithItems,
  type PickupCode,
} from "@/lib/commerce";
import { OrderStatusBadge } from "@/components/orders/OrderStatusBadge";
import { orderStatusCopy } from "@/lib/order-status-copy";
import { ReservationCountdown } from "@/components/orders/ReservationCountdown";
import { PaymentProofUpload } from "@/components/orders/PaymentProofUpload";
import { PaymentMethods } from "@/components/orders/PaymentMethods";
import { formatMoneyUnits } from "@/lib/format";
import { getTranslator } from "@/lib/i18n/server";
import { getOrderStorePublicInfo, parseOrderPaymentMethod } from "@/lib/stores.server";
import { whatsappUrl } from "@/lib/whatsapp";
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

// El tono del badge ya NO se define acá: vive en `lib/order-status-copy.ts` y lo
// pinta `components/orders/OrderStatusBadge.tsx`, compartido con el panel del
// merchant. Así un cambio de criterio no deja dos pantallas contradiciéndose.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Estados de regreso del checkout de Mercado Pago (`back_urls`).
 *
 * `?pago=exitoso` NO significa "pago acreditado": significa que MP nos devolvió al
 * comprador por la URL de pago aprobado. La verdad la dice el pedido cuando llega la
 * confirmación desde MP, no el query param.
 */

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
type PaymentProofStatus = "submitted" | "approved" | "rejected";
type PaymentProofMeta = {
  url: string;
  status: PaymentProofStatus;
} | null;

/**
 * Comprobante que subió el comprador, desde `orders.metadata.paymentProof`.
 * Un JSON viejo o incompleto no rompe la pantalla: sin URL no hay comprobante.
 */
function readPaymentProof(order: Pick<OrderWithItems, "metadata">): PaymentProofMeta {
  const proof = order.metadata?.paymentProof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const record = proof as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url) return null;
  const status =
    record.status === "approved" || record.status === "rejected"
      ? record.status
      : "submitted";
  return { url: record.url, status };
}

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
  proofStatus,
  t,
}: {
  order: OrderWithItems;
  hasPickupCode: boolean;
  proofStatus: PaymentProofStatus | null;
  t: Translator;
}) {
  if (proofStatus === "rejected") {
    return (
      <p
        role="status"
        className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-body text-destructive"
      >
        {t("order.notice.proofRejected")}
      </p>
    );
  }

  if (order.status === "pending_payment" && proofStatus === "submitted") {
    return null;
  }

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

    // La reserva viva se comunica UNA sola vez, en el panel de urgencia con el
    // contador al lado. Repetir "estamos guardando tus artículos" arriba y abajo
    // era ruido y empujaba el pago fuera de pantalla.
    return null;
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
        {t("order.notice.ready")}
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
function PickupCodeTicket({ code, t }: { code: PickupCode; t: Translator }) {
  const expiresAt = formatDateTime(code.expiresAt);
  // No hay compartimento físico en el MVP: se ignora el slot a propósito para no
  // mostrar ubicaciones que no existen. El recojo es asistido en tienda.
  const location = t("order.storeCounter");

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
}: {
  params: Promise<{ token: string }>;
}) {
  // En esta versión de Next `params` y `searchParams` son Promises: hay que esperarlas.
  const { token } = await params;
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

  let proof = readPaymentProof(order);

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
  // Un comprobante enviado toma el control de la reserva: la tienda debe revisar
  // el pago antes de que un barrido devuelva el stock. Por eso no se expira acá.
  if (
    order.status === "pending_payment" &&
    proof?.status !== "submitted" &&
    evaluateOrderPayability(order) !== "payable"
  ) {
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
  proof = readPaymentProof(order);

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

  const storeInfo = await getOrderStorePublicInfo(order.id).catch(() => null);
  const awaitingReview =
    order.status === "pending_payment" && proof?.status === "submitted";
  const paymentMethod = parseOrderPaymentMethod(order.metadata) ?? "yape";
  const payments = storeInfo?.payments ?? null;
  const hasPaymentDetails = Boolean(
    payments && (payments.yape || payments.plin || payments.bankAccount),
  );

  const statusLabel = awaitingReview
    ? t("order.reviewBadge")
    : t(`status.${order.status}` as MessageKey);
  const statusCopy = orderStatusCopy(order.status);
  const fulfillmentLabel = t(`order.fulfillment.${order.fulfillmentType}` as MessageKey);
  const placedAt = formatDateTime(order.createdAt);

  // Misma regla que aplica el endpoint de pago (una sola definición, en lib/commerce.ts).
  const payability = evaluateOrderPayability(order);
  const canPay = payability === "payable";
  const simulated = isSimulatedPayment(order);


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
          <OrderStatusBadge status={order.status} label={statusLabel} size="lg" />
          {simulated && (
            <span
              className="rounded-full border border-warning/40 bg-warning/10 px-4 py-1 text-body text-warning"
              title={t("order.simulatedTitle")}
            >
              {t("order.simulatedBadge")}
            </span>
          )}
        </div>

        <p className="mt-3 text-body text-secondary">
          {awaitingReview ? t("order.reviewBody") : t(statusCopy.explanationKey as MessageKey)}
        </p>

        <p className="mt-1 text-body text-tertiary">
          {placedAt ? t("order.placedOn", { date: placedAt }) : t("order.justPlaced")}
          {order.itemCount > 0
            ? ` · ${t(
                order.itemCount === 1 ? "order.itemCountOne" : "order.itemCountMany",
                { count: order.itemCount },
              )}`
            : ""}
        </p>

        <Notice
          order={order}
          hasPickupCode={pickupCode !== null}
          proofStatus={proof?.status ?? null}
          t={t}
        />

        {awaitingReview && (
          <section className="mt-6 rounded-3xl border border-info/40 bg-info/10 p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[2px] text-info">
              {t("order.reviewTitle")}
            </p>
            <p className="mt-2 text-body text-secondary">{t("order.reviewBody")}</p>
            <div className="mt-4 flex items-baseline justify-between border-y border-info/30 py-3">
              <span className="text-body font-medium">{t("order.total")}</span>
              <span className="font-mono text-xl font-semibold tabular-nums">
                {money(order.total, order.currency)}
              </span>
            </div>
            {storeInfo?.whatsapp && (
              <a
                href={
                  whatsappUrl(
                    storeInfo.whatsapp,
                    t("order.notifyStoreMessage", {
                      store: storeInfo.name,
                      order: order.orderNumber,
                      total: money(order.total, order.currency),
                    }),
                  ) ?? "#"
                }
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand px-4 text-body font-semibold text-background hover:opacity-90"
              >
                {t("order.notifyStore")}
              </a>
            )}
          </section>
        )}

        {!awaitingReview && order.status === "pending_payment" && payability === "payable" && order.reservationExpiresAt && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-warning/50 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[2px] text-warning">
                {t("order.urgencyKicker")}
              </p>
              <p className="mt-1 text-body text-secondary">{t("order.urgencyCopy")}</p>
            </div>
            <div className="shrink-0 rounded-xl border border-warning/30 bg-background px-4 py-2 text-center">
              <p className="text-[10px] uppercase tracking-[1.5px] text-muted">
                {t("order.timeLeft")}
              </p>
              <ReservationCountdown
                expiresAt={order.reservationExpiresAt}
                expiredLabel={t("order.expiredCountdown")}
                className="mt-0.5 block font-mono text-3xl font-bold tabular-nums tracking-tight text-warning"
                urgentClassName="text-destructive animate-pulse"
              />
            </div>
          </div>
        )}


        {pickupCode && <PickupCodeTicket code={pickupCode} t={t} />}

        {canPay && !awaitingReview && (
          <div className="mt-6 rounded-3xl border border-border bg-surface p-6">
            <div className="mb-2 text-xs tracking-widest text-tertiary">{t("order.paymentKicker")}</div>
            <p className="text-body text-secondary">{t("order.paymentManualBody")}</p>

            <div className="mt-4 flex items-baseline justify-between border-y border-border py-3">
              <span className="text-body font-medium">{t("order.total")}</span>
              <span className="font-mono text-xl font-semibold tabular-nums">
                {money(order.total, order.currency)}
              </span>
            </div>

            {paymentMethod === "cash" ? (
              <div className="mt-4 rounded-2xl border border-info/40 bg-info/10 p-4">
                <p className="text-body font-semibold text-info">{t("order.payCashTitle")}</p>
                <p className="mt-1 text-sm text-secondary">{t("order.payCashBody")}</p>
                <p className="mt-2 text-sm font-medium text-info">{t("order.payCashPending")}</p>
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-[11px] uppercase tracking-[1.5px] text-muted">
                  {t("order.payMethodsTitle")}
                </p>

                {hasPaymentDetails && payments ? (
                  <PaymentMethods payments={payments} initialMethod={paymentMethod} />
                ) : (
                  <p className="mt-2 rounded-xl border border-border bg-background px-4 py-3 text-sm text-secondary">
                    {t("order.payMissing")}
                  </p>
                )}

                {hasPaymentDetails && (
                  <p className="mt-2 text-xs text-muted">{t("order.payTapToCopy")}</p>
                )}
                <p className="mt-3 text-sm text-secondary">{t("order.proofOnly")}</p>
              </div>
            )}

            {storeInfo?.whatsapp ? (
              <a
                href={
                  whatsappUrl(
                    storeInfo.whatsapp,
                    t("order.notifyStoreMessage", {
                      store: storeInfo.name,
                      order: order.orderNumber,
                      total: money(order.total, order.currency),
                    }),
                  ) ?? "#"
                }
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand px-4 text-body font-semibold text-background hover:opacity-90"
              >
                {t("order.notifyStore")}
              </a>
            ) : (
              <p className="mt-4 text-sm text-tertiary">{t("order.storeWhatsAppSoon")}</p>
            )}

            {paymentMethod !== "cash" && (
              <>
                <PaymentProofUpload publicToken={order.publicToken} status={proof?.status ?? null} />
                <p className="mt-3 text-xs text-tertiary">{t("order.proofRule")}</p>
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
              <div className="w-16 h-16 rounded-2xl bg-surface-raised flex-shrink-0 flex items-center justify-center text-body-lg font-semibold text-secondary">
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
            {/* El MVP no tiene compartimento físico: el recojo es asistido en tienda. */}
            {order.fulfillmentType !== "delivery" &&
              (order.status === "confirmed" || order.status === "preparing") && (
                <p className="mt-2 text-body text-secondary">{t("order.pickupHint")}</p>
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
