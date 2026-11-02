/**
 * /negocio/<storeId> — panel de UNA tienda.
 *
 * Todas las lecturas pasan por funciones que exigen membresía
 * (`requireStoreAccess`). Si el usuario pertenece a la tienda A y escribe el ID
 * de la B en la URL, recibe 404: no se revela ni el nombre.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MerchantCatalog } from './MerchantCatalog';
import { StoreBilling } from './StoreBilling';
import { StoreIdentityForm } from './StoreIdentityForm';
import { StoreLocationForm } from './StoreLocationForm';
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge';
import { resolveAnalyticsRange } from '@/lib/analytics';
import type { MessageKey } from '@/lib/i18n/dictionaries';
import { merchantOrderStatusKey, orderStatusCopy } from '@/lib/order-status-copy';
import { storeStatusLabel } from '@/lib/i18n/store-status';
import { canEditStoreIdentity, publicStoreUrl } from '@/lib/store-identity';
import { resolveMerchantStoreStatus } from '@/lib/store-status';
import { getCurrentUser } from '@/lib/current-user.server';
import { formatDate as formatDateLocale, formatMoney, unitsToCents } from '@/lib/format';
import { getTranslator } from '@/lib/i18n/server';
import { getAnalyticsSummary } from '@/lib/analytics.server';
import { getStoreBillingForUser } from '@/lib/billing/subscriptions.server';
import {
  listStoreOrders,
  listStoreProducts,
  requireStoreAccess,
} from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return { title: t('merchant.dashboard'), robots: { index: false, follow: false } };
}

interface PageProps {
  params: Promise<{ storeId: string }>;
}

export default async function MerchantStorePage({ params }: PageProps) {
  const { locale, t } = await getTranslator();
  const user = await getCurrentUser();
  const { storeId } = await params;
  if (!user) redirect(`/ingresar?next=/negocio/${storeId}`);

  let store;
  try {
    ({ store } = await requireStoreAccess(user.id, storeId));
  } catch {
    notFound();
  }

  // Estado real: activa · pendiente de revisión · falta completarla.
  const status = resolveMerchantStoreStatus(store);
  // Nombre y dirección pública solo se editan antes de la primera publicación.
  const canEditIdentity = canEditStoreIdentity(store);

  const [products, orders, billing] = await Promise.all([
    listStoreProducts(user.id, storeId),
    listStoreOrders(user.id, storeId, 30),
    getStoreBillingForUser(user.id, storeId).catch(() => null),
  ]);

  const rangeResult = resolveAnalyticsRange({ preset: '30d' });
  const summary = rangeResult.ok
    ? await getAnalyticsSummary({
        range: rangeResult.range,
        previous: rangeResult.previous,
        storeId,
      }).catch(() => null)
    : null;

  const sales = summary?.sales;

  // Los pedidos vivos van primero y con más contraste; el historial (expirados,
  // cancelados, ya retirados) queda atenuado y después. El orden lo define
  // `lib/order-status-copy.ts`, no cada pantalla.
  const groupedOrders = [
    {
      key: 'attention',
      titleKey: 'merchant.ordersAttention' as const,
      orders: orders.filter((order) => !orderStatusCopy(order.status).secondary),
    },
    {
      key: 'history',
      titleKey: 'merchant.ordersHistory' as const,
      orders: orders.filter((order) => orderStatusCopy(order.status).secondary),
    },
  ].filter((group) => group.orders.length > 0);

  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 pt-6 sm:px-6">
      <nav className="text-xs text-muted">
        <Link href="/negocio" className="hover:text-primary">
          {t('merchant.breadcrumb')}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{store.name}</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{store.name}</h1>
          <p className="mt-1 text-sm text-tertiary">
            /{store.slug} · {store.category ?? t('merchant.categoryNone')} ·{' '}
            <span className={status.state === 'active' ? 'text-success' : 'text-warning'}>
              {storeStatusLabel(t, status.state)}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          {status.state === 'active' ? (
            <Link
              href={`/${store.slug}`}
              className="inline-flex h-9 items-center rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised"
            >
              {t('merchant.viewStore')}
            </Link>
          ) : (
            <span className="inline-flex h-9 items-center rounded-xl border border-border px-3 text-xs text-tertiary">
              {t('merchant.hidden')}
            </span>
          )}
        </div>
      </header>

      {status.state === 'pending_review' && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {t('merchant.pendingNotice')}
        </div>
      )}

      <section
        id="identidad"
        aria-labelledby="identidad-title"
        className="mt-4 rounded-2xl border border-border bg-surface p-4"
      >
        <h2 id="identidad-title" className="text-sm font-semibold text-secondary">
          {t('merchant.identityHeading')}
        </h2>
        {canEditIdentity ? (
          <StoreIdentityForm
            storeId={storeId}
            initialName={store.name}
            initialSlug={store.slug}
          />
        ) : (
          <div className="mt-2">
            <p className="text-xs font-medium text-tertiary">
              {t('merchant.identityPublicAddress')}
            </p>
            <p className="mt-1 break-all font-mono text-sm text-primary">
              {publicStoreUrl(store.slug)}
            </p>
            <p className="mt-1 text-xs text-tertiary">{t('merchant.identityLocked')}</p>
          </div>
        )}
      </section>

      {status.missing === 'location' && (
        <section
          id="ubicacion"
          aria-labelledby="ubicacion-title"
          className="mt-4 rounded-2xl border border-warning/40 bg-warning/10 p-4"
        >
          <h2 id="ubicacion-title" className="text-sm font-semibold text-warning">
            {t('merchant.locationTitle')}
          </h2>
          <p className="mt-1 text-sm text-secondary">{t('merchant.incompleteNotice')}</p>
          <p className="mt-1 text-xs text-tertiary">{t('merchant.locationBody')}</p>
          <div className="mt-3">
            <StoreLocationForm storeId={storeId} />
          </div>
        </section>
      )}

      {status.hasLocation && (
        <section
          id="ubicacion"
          aria-labelledby="ubicacion-title"
          className="mt-4 rounded-2xl border border-border bg-surface p-4"
        >
          <h2 id="ubicacion-title" className="text-sm font-semibold text-secondary">
            {t('merchant.locationHeading')}
          </h2>
          <p className="mt-1 text-sm text-primary">{store.address ?? t('merchant.locationNoAddress')}</p>
          <p className="mt-0.5 text-xs text-tertiary">
            {[store.district, store.province, store.department].filter(Boolean).join(' · ') ||
              t('merchant.locationNoUbigeo')}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-tertiary underline-offset-2 hover:text-primary hover:underline">
              {t('merchant.changeLocation')}
            </summary>
            <div className="mt-3">
              <StoreLocationForm
                storeId={storeId}
                initial={
                  store.latitude !== null && store.longitude !== null
                    ? {
                        ubigeo: store.ubigeo ?? '',
                        address: store.address ?? '',
                        reference: store.reference ?? '',
                        latitude: store.latitude,
                        longitude: store.longitude,
                      }
                    : null
                }
              />
            </div>
          </details>
        </section>
      )}

      {billing && <StoreBilling storeId={storeId} initialBilling={billing} />}

      {/* KPIs */}
      <section aria-label={t('merchant.summary')} className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.sales30')}</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatMoney(sales?.revenueCents ?? 0, 'PEN', locale)}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.orders')}</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{sales?.orders ?? 0}</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.averageTicket')}</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatMoney(sales?.averageTicketCents ?? 0, 'PEN', locale)}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.lowStock')}</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {summary ? summary.lowStock.length + summary.outOfStock.length : 0}
          </div>
        </div>
      </section>

      {/* Productos */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('merchant.products')}
          </h2>
          <span className="text-xs text-muted tabular-nums">{products.length}</span>
        </div>

        <MerchantCatalog storeId={storeId} products={products} />
      </section>

      {/* Pedidos */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('merchant.orders')}
          </h2>
          <span className="text-xs text-muted tabular-nums">{orders.length}</span>
        </div>

        {orders.length === 0 ? (
          <p className="py-4 text-sm text-tertiary">{t('merchant.noOrders')}</p>
        ) : (
          <div className="mt-3 space-y-5">
            {groupedOrders.map((group) => (
              <div key={group.key}>
                <h3 className="text-[11px] font-semibold uppercase tracking-[2px] text-tertiary">
                  {t(group.titleKey)}
                </h3>
                <ul className="mt-2 space-y-2">
                  {group.orders.map((order) => {
                    const copy = orderStatusCopy(order.status);
                    return (
                      <li key={order.id}>
                        {/* Fila entera tappable: el número de pedido, el estado y el total
                            son lo que el comerciante busca; el resto queda secundario. */}
                        <Link
                          href={`/negocio/${storeId}/pedidos/${order.id}`}
                          className={`flex min-h-16 items-center gap-3 rounded-2xl border px-4 py-3 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                            copy.secondary
                              ? 'border-border bg-surface'
                              : 'border-border-strong bg-surface'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className={`font-mono text-body font-semibold tabular-nums ${copy.secondary ? 'text-secondary' : 'text-primary'}`}>
                                {order.orderNumber}
                              </span>
                              <OrderStatusBadge
                                status={order.status}
                                label={t(merchantOrderStatusKey(order.status) as MessageKey)}
                              />
                            </div>
                            <p className="mt-1 truncate text-xs text-tertiary">
                              {formatDateLocale(order.createdAt, locale, {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}{' '}
                              · {order.contactEmail}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className={`font-mono text-body font-semibold tabular-nums ${copy.secondary ? 'text-secondary' : 'text-primary'}`}>
                              {formatMoney(unitsToCents(order.total), order.currency, locale)}
                            </div>
                            <div className="text-xs text-tertiary">
                              {t('merchant.itemsShort', { count: order.itemCount })}
                            </div>
                          </div>
                          <span aria-hidden="true" className="shrink-0 text-base text-tertiary">
                            ›
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {summary && summary.topProducts.length > 0 && (
        <section className="mt-8">
          <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('merchant.topProducts')}
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {summary.topProducts.slice(0, 5).map((product) => (
              <li key={product.productSlug} className="flex justify-between gap-3">
                <span className="truncate text-secondary">{product.productName}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-tertiary">
                  {product.quantity} · {formatMoney(product.revenueCents, 'PEN', locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
