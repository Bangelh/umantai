/**
 * /negocio/<storeId>/pedidos/<orderId> — detalle de UN pedido del comerciante.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  La lista del panel mostraba una fila compacta (número, estado, hora, correo,
 *  cantidad, total) y no había forma de abrir el pedido: para prepararlo, el
 *  comerciante necesitaba la variante exacta y el desglose de precios. Esta es la
 *  vista que responde "¿qué tengo que entregar y qué hago ahora?".
 *
 *  El copy del estado NO se escribe acá: sale de `lib/order-status-copy.ts`, así el
 *  merchant y el comprador nunca cuentan dos versiones distintas.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge';
import { getCurrentUser } from '@/lib/current-user.server';
import { formatDate as formatDateLocale, formatMoneyUnits } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n/dictionaries';
import { getTranslator } from '@/lib/i18n/server';
import { orderStatusLabel } from '@/lib/i18n/status';
import { orderStatusCopy, paymentStatusKey } from '@/lib/order-status-copy';
import { getStoreOrderDetail, requireStoreAccess } from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ storeId: string; orderId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return { title: t('merchant.orders'), robots: { index: false, follow: false } };
}

export default async function MerchantOrderDetailPage({ params }: PageProps) {
  const { locale, t } = await getTranslator();
  const user = await getCurrentUser();
  const { storeId, orderId } = await params;
  if (!user) redirect(`/ingresar?next=/negocio/${storeId}/pedidos/${orderId}`);

  let store;
  try {
    ({ store } = await requireStoreAccess(user.id, storeId));
  } catch {
    notFound();
  }

  // `getStoreOrderDetail` filtra por `store_id`: el pedido de otra tienda es 404.
  const order = await getStoreOrderDetail(user.id, storeId, orderId).catch(() => null);
  if (!order) notFound();

  const copy = orderStatusCopy(order.status);
  const statusLabel = t((copy.merchantLabelKey ?? copy.labelKey) as MessageKey);
  const placedAt = formatDateLocale(order.createdAt, locale, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const expiresAt = order.reservationExpiresAt
    ? formatDateLocale(order.reservationExpiresAt, locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  const money = (value: number) => formatMoneyUnits(value, order.currency, locale);
  const variantText = (line: (typeof order.lines)[number]) =>
    Object.entries(line.variant)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ');

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 pt-6 sm:px-6">
      <nav className="text-xs text-muted">
        <Link href="/negocio" className="hover:text-primary">
          {t('merchant.breadcrumb')}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/negocio/${storeId}`} className="hover:text-primary">
          {store.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{order.orderNumber}</span>
      </nav>

      <Link
        href={`/negocio/${storeId}`}
        className="mt-4 inline-flex min-h-11 items-center text-sm text-secondary underline-offset-4 hover:text-primary hover:underline"
      >
        ← {t('merchant.backToStore')}
      </Link>

      <header className="mt-2 flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <h1 className="font-mono text-3xl font-semibold tracking-tight tabular-nums">
          {order.orderNumber}
        </h1>
        <OrderStatusBadge status={order.status} label={statusLabel} size="lg" />
      </header>

      <p className="mt-3 text-sm text-tertiary">
        {t('merchant.orderPlaced', { date: placedAt })}
      </p>

      <p className="mt-2 text-body text-secondary">{t(copy.explanationKey as MessageKey)}</p>

      {/* Aviso operativo: lo primero que tiene que leer el comerciante. */}
      {order.status === 'pending_payment' && (
        <div className="mt-4 rounded-2xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-body font-semibold text-warning">{t('merchant.waitingPayment')}</p>
          <p className="mt-1 text-body text-secondary">{t('merchant.waitingPaymentWarning')}</p>
          <p className="mt-2 text-body text-secondary">
            {order.reservationReleased
              ? t('merchant.reservationReleased')
              : expiresAt
                ? t('merchant.reservationUntil', { date: expiresAt })
                : t('merchant.reservation')}
          </p>
        </div>
      )}

      <section aria-label={t('merchant.orderStatus')} className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t('merchant.orderStatus')}
          </div>
          <div className="mt-1 text-sm font-medium text-primary">{statusLabel}</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t('merchant.paymentStatus')}
          </div>
          <div className="mt-1 text-sm font-medium text-primary">
            {t(paymentStatusKey(order.paymentStatus) as MessageKey)}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t('merchant.fulfillment')}
          </div>
          <div className="mt-1 text-sm font-medium text-primary">
            {t(`order.fulfillment.${order.fulfillmentType}` as MessageKey)}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t('merchant.customer')}
          </div>
          <div className="mt-1 break-all text-sm font-medium text-primary">{order.contactEmail}</div>
          {order.contactPhone && (
            <div className="mt-0.5 text-xs text-tertiary">{order.contactPhone}</div>
          )}
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.reservation')}</div>
          <div className="mt-1 text-sm font-medium text-primary">
            {order.reservationReleased
              ? t('merchant.reservationReleased')
              : expiresAt
                ? t('merchant.reservationUntil', { date: expiresAt })
                : '—'}
          </div>
        </div>
      </section>

      {order.customerNote && (
        <section className="mt-4 rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-[11px] uppercase tracking-wide text-muted">{t('order.yourNote')}</h2>
          <p className="mt-1 whitespace-pre-wrap text-body text-secondary">{order.customerNote}</p>
        </section>
      )}

      {/* Líneas: producto, variante, cantidad, precio unitario y subtotal. */}
      <section className="mt-6">
        <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
          {t('merchant.lines')}
        </h2>
        <ul className="mt-2 space-y-2">
          {order.lines.map((line) => (
            <li key={line.id} className="rounded-2xl border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-primary">{line.productName}</p>
                  {line.productBrand && (
                    <p className="text-xs text-tertiary">{line.productBrand}</p>
                  )}
                  {variantText(line) && (
                    <p className="mt-1 text-xs text-tertiary">
                      {t('merchant.variantLabel')}: {variantText(line)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-body font-semibold tabular-nums text-primary">
                    {money(line.lineTotal)}
                  </div>
                  <div className="mt-0.5 text-xs text-tertiary">
                    {line.quantity} × {money(line.unitPrice)}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 border-t border-border pt-4">
        <dl className="space-y-1.5 text-body">
          <div className="flex justify-between text-secondary">
            <dt>{t('order.subtotal')}</dt>
            <dd className="font-mono tabular-nums">{money(order.subtotal)}</dd>
          </div>
          {order.discountTotal > 0 && (
            <div className="flex justify-between text-secondary">
              <dt>{t('order.discount')}</dt>
              <dd className="font-mono tabular-nums">−{money(order.discountTotal)}</dd>
            </div>
          )}
          {order.shippingTotal > 0 && (
            <div className="flex justify-between text-secondary">
              <dt>{t('order.shipping')}</dt>
              <dd className="font-mono tabular-nums">{money(order.shippingTotal)}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between border-t border-border pt-3 text-xl">
            <dt className="font-semibold">{t('order.total')}</dt>
            <dd className="font-mono font-semibold tabular-nums">{money(order.total)}</dd>
          </div>
        </dl>
      </section>

      <section
        aria-label={t('merchant.nextAction')}
        className="mt-6 rounded-2xl border border-border-strong bg-surface-raised p-4"
      >
        <h2 className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.nextAction')}</h2>
        <p className="mt-1 text-body text-primary">{t(copy.actionKey as MessageKey)}</p>
      </section>
    </main>
  );
}
