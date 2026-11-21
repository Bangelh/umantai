/**
 * /negocio/<storeId> — panel de UNA tienda.
 *
 * Todas las lecturas pasan por funciones que exigen membresía
 * (`requireStoreAccess`). Si el usuario pertenece a la tienda A y escribe el ID
 * de la B en la URL, recibe 404: no se revela ni el nombre.
 *
 * Orden de la pantalla: primero lo que hay que HACER (pedidos y avisos), luego
 * cómo va el negocio (ventas, inventario) y al final la configuración. Antes los
 * pedidos quedaban después de identidad, WhatsApp y pagos: había que bajar mucho
 * para encontrar el trabajo del día.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  Check,
  ChevronDown,
  Clock,
  CreditCard,
  MapPin,
  MessageCircle,
  ShoppingBag,
  Store as StoreIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cache, type ReactNode } from 'react';
import { AuroraBackdrop } from '@/components/ui/AuroraBackdrop';
import { EmptyState } from '@/components/ui/EmptyState';
import { SpotlightSurface } from '@/components/ui/SpotlightSurface';
import { MerchantCatalog } from './MerchantCatalog';
import { StoreBilling } from './StoreBilling';
import { StoreIdentityForm } from './StoreIdentityForm';
import { StoreLogoButton } from './StoreLogoButton';
import { StoreWhatsAppForm } from './StoreWhatsAppForm';
import { StoreHoursForm } from './StoreHoursForm';
import { StorePaymentsForm } from './StorePaymentsForm';
import { StoreLocationForm } from './StoreLocationForm';
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge';
import { SalesChart } from '@/app/admin/analytics/components/SalesChart';
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
  getStoreHoursForOwner,
  getStorePaymentsForOwner,
  listStoreOrders,
  listStoreProducts,
  requireStoreAccess,
} from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

/**
 * Compuerta memoizada por request: `generateMetadata` y la página la comparten,
 * así el chequeo de membresía cuesta una sola consulta.
 */
const loadStoreAccess = cache(async (userId: string, storeId: string) => {
  try {
    return await requireStoreAccess(userId, storeId);
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { t } = await getTranslator();
  const user = await getCurrentUser();

  // Con sesión, el 404 se decide acá: la metadata se resuelve antes de abrir el
  // stream. Si se lanzara desde la página (después de su primer `await` y con
  // `loading.tsx` presente) la respuesta ya viajó como 200 y solo quedaría el
  // `<meta name="robots" content="noindex">`.
  if (user) {
    const { storeId } = await params;
    if (!(await loadStoreAccess(user.id, storeId))) notFound();
  }

  return { title: t('merchant.dashboard'), robots: { index: false, follow: false } };
}

interface PageProps {
  params: Promise<{ storeId: string }>;
}

/**
 * Sección de configuración: icono, título y una superficie propia.
 *
 * Los ajustes son lo último de la página y se abren desde un `<details>`.
 * Cada bloque necesita separarse del siguiente sin competir con el trabajo
 * diario: por eso usa `surface-raised` (no `surface-card`) y deja el borde
 * fuerte para el estado que requiere atención.
 */
function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  tone = 'default',
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  tone?: 'default' | 'warning';
  children: ReactNode;
}) {
  const warning = tone === 'warning';

  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`rounded-2xl border p-4 sm:p-5 ${
        warning ? 'border-warning/40 bg-warning/10' : 'border-border bg-surface-raised/30'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
            warning
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-border bg-surface text-secondary'
          }`}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            id={`${id}-title`}
            className={`text-body font-semibold ${warning ? 'text-warning' : 'text-primary'}`}
          >
            {title}
          </h3>
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-secondary">{description}</p>
          )}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

export default async function MerchantStorePage({ params }: PageProps) {
  const { locale, t } = await getTranslator();
  const user = await getCurrentUser();
  const { storeId } = await params;
  if (!user) redirect(`/ingresar?next=/negocio/${storeId}`);

  const access = await loadStoreAccess(user.id, storeId);
  if (!access) notFound();
  const { store } = access;

  const status = resolveMerchantStoreStatus(store);
  const canEditIdentity = canEditStoreIdentity(store);

  const [products, orders, billing, payments, hours] = await Promise.all([
    listStoreProducts(user.id, storeId),
    listStoreOrders(user.id, storeId, 30),
    getStoreBillingForUser(user.id, storeId).catch(() => null),
    getStorePaymentsForOwner(user.id, storeId).catch(() => null),
    getStoreHoursForOwner(user.id, storeId).catch(() => null),
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
  const pendingPayments = orders.filter((order) => order.status === 'pending_payment').length;
  const toPrepare = orders.filter(
    (order) => order.status === 'confirmed' || order.status === 'preparing',
  ).length;
  const readyOrders = orders.filter((order) => order.status === 'ready_for_pickup').length;
  const stockAlerts = summary ? summary.lowStock.length + summary.outOfStock.length : 0;
  const paymentsConfigured = Boolean(
    payments && (payments.yape || payments.plin || payments.bankAccount),
  );

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

  const quickLinks = [
    { href: '#pedidos', label: t('merchant.orders') },
    { href: '#pagos', label: t('merchant.paymentsHeading') },
    { href: '#inventario', label: t('merchant.inventoryTitle') },
    { href: '#productos', label: t('merchant.products') },
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 pt-6 sm:px-6">
      {/* El panel es una herramienta de trabajo: la atmósfera se limita a la
          cabecera. Las secciones de abajo no se animan para no distraer. */}
      <div className="relative isolate -mx-4 px-4 pb-1 sm:-mx-6 sm:px-6">
        <AuroraBackdrop />
      <nav className="relative text-xs text-muted">
        <Link href="/negocio" className="hover:text-primary">
          {t('merchant.breadcrumb')}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{store.name}</span>
      </nav>

      <SpotlightSurface
        className="surface-card relative mt-4"
        bodyClassName="flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5"
      >
        <div className="flex min-w-0 items-start gap-3">
          {store.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- imagen subida por el comercio
            <img
              src={store.logoUrl}
              alt={`Logo de ${store.name}`}
              className="h-14 w-14 shrink-0 rounded-2xl border border-border object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-raised text-xl font-semibold text-tertiary"
            >
              {store.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[2px] text-muted">
              {t('merchant.panelKicker')}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{store.name}</h1>
            <p className="mt-1 text-sm text-tertiary">
              /{store.slug} · {store.category ?? t('merchant.categoryNone')}
            </p>
            <span
              className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                status.state === 'active'
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-warning/40 bg-warning/10 text-warning'
              }`}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              {storeStatusLabel(t, status.state)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <StoreLogoButton storeId={storeId} hasLogo={!!store.logoUrl} />
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
      </SpotlightSurface>
      </div>

      {status.state === 'pending_review' && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {t('merchant.pendingNotice')}
        </div>
      )}

      <nav
        aria-label={t('merchant.quickNav')}
        className="sticky top-20 z-30 -mx-4 mt-4 flex gap-2 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:bg-surface/95 sm:px-2"
      >
        {quickLinks.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="inline-flex h-10 shrink-0 items-center rounded-full border border-border-strong bg-surface px-3 text-sm font-medium hover:bg-surface-raised"
          >
            {link.label}
          </a>
        ))}
      </nav>

      {!paymentsConfigured && (
        <section className="mt-4 rounded-2xl border border-warning/50 bg-warning/10 p-4">
          <h2 className="text-base font-semibold text-warning">{t('merchant.paymentsMissingTitle')}</h2>
          <p className="mt-1 text-sm text-secondary">{t('merchant.paymentsMissingBody')}</p>
          <a
            href="#pagos"
            className="mt-3 inline-flex h-11 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-background"
          >
            {t('merchant.configurePayments')}
          </a>
        </section>
      )}

      {/* Lo que hay que hacer hoy, sin bajar. */}
      <section aria-label={t('merchant.attentionTitle')} className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          { href: '#pedidos', value: pendingPayments, label: t('merchant.awaitingPayment') },
          { href: '#pedidos', value: toPrepare, label: t('merchant.toPrepare') },
          { href: '#pedidos', value: readyOrders, label: t('merchant.readyToPickup') },
          { href: '#inventario', value: stockAlerts, label: t('merchant.lowStock') },
        ].map((card) => (
          <a
            key={card.label}
            href={card.href}
            className={`rounded-2xl border p-3 transition-colors hover:bg-surface-raised sm:p-4 ${
              card.value > 0 ? 'border-warning/40 bg-warning/5' : 'border-border bg-surface'
            }`}
          >
            <span className="block font-mono text-3xl font-semibold tabular-nums sm:text-4xl">{card.value}</span>
            <span className="mt-1 block text-xs leading-snug text-secondary sm:text-sm">{card.label}</span>
          </a>
        ))}
      </section>

      {/* KPIs de venta. */}
      <section aria-label={t('merchant.summary')} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
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
          <div className="text-[11px] uppercase tracking-wide text-muted">{t('merchant.products')}</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{products.length}</div>
        </div>
      </section>

      {/* Pedidos: lo primero después de los números. */}
      <section id="pedidos" className="mt-8 scroll-mt-[9rem]">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('merchant.orders')}
          </h2>
          <span className="text-xs text-muted tabular-nums">{orders.length}</span>
        </div>

        {orders.length === 0 ? (
          <EmptyState
            compact
            icon={ShoppingBag}
            title={t('merchant.noOrdersTitle')}
            description={t('merchant.noOrdersBody')}
            action={
              status.state === 'active' ? (
                <Link href={`/${store.slug}`} className="btn-secondary text-sm">
                  {t('merchant.viewStore')}
                </Link>
              ) : undefined
            }
            className="mt-3"
          />
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
                            <p className="mt-1 truncate text-sm text-secondary">
                              {order.buyerName ?? order.contactEmail}
                            </p>
                            <p className="truncate text-xs text-tertiary">
                              {formatDateLocale(order.createdAt, locale, {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}
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

      {summary && summary.series.daily.length > 0 && (
        <section className="mt-8">
          <SalesChart
            points={summary.series.daily.slice(-14)}
            title={t('merchant.salesChartTitle')}
            granularity="daily"
          />
        </section>
      )}

      {/* Cobros: el comerciante tiene que saber dónde poner Yape/Plin. */}
      <section
        id="pagos"
        aria-labelledby="payments-title"
        className="surface-card mt-8 scroll-mt-[9rem] p-4 sm:p-5"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-raised text-secondary"
          >
            <CreditCard className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="payments-title" className="text-body font-semibold text-primary">
              {t('merchant.paymentsHeading')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-secondary">
              {t('merchant.paymentsBody')}
            </p>
            <div className="mt-4">
              <StorePaymentsForm
                storeId={storeId}
                initial={
                  payments ?? {
                    yape: null,
                    plin: null,
                    bankAccount: null,
                    holder: null,
                    cash: false,
                  }
                }
              />
            </div>
          </div>
        </div>
      </section>

      {/* Inventario: qué se está agotando y cómo gestionarlo. */}
      <section id="inventario" className="mt-8 scroll-mt-[9rem]">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('merchant.inventoryTitle')}
          </h2>
          <a href="#productos" className="text-xs font-medium text-brand underline-offset-2 hover:underline">
            {t('merchant.manageInventory')} →
          </a>
        </div>
        <p className="mt-1 text-xs text-tertiary">{t('merchant.inventoryBody')}</p>

        {summary && (summary.lowStock.length > 0 || summary.outOfStock.length > 0) ? (
          <ul className="mt-2 divide-y divide-border rounded-2xl border border-border bg-surface">
            {[...summary.outOfStock, ...summary.lowStock].slice(0, 6).map((item) => (
              <li key={`${item.productSlug}-${item.variantKey}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-primary">{item.productName}</p>
                  <p className="truncate text-xs text-tertiary">{item.variantLabel}</p>
                </div>
                <span className={`shrink-0 font-mono text-sm font-semibold tabular-nums ${item.available <= 0 ? 'text-destructive' : 'text-warning'}`}>
                  {item.available <= 0 ? t('merchant.outOfStock') : `${item.available} ${t('merchant.unitsShort')}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={Check}
            title={t('merchant.noLowStock')}
            description={t('merchant.noLowStockBody')}
            className="mt-2"
          />
        )}
      </section>

      {/* Productos + ajustes de stock. */}
      <section id="productos" className="mt-8 scroll-mt-[9rem]">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('merchant.products')}
          </h2>
          <span className="text-xs text-muted tabular-nums">{products.length}</span>
        </div>
        <MerchantCatalog storeId={storeId} products={products} />
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

      {/* Configuración: ya no estorba el trabajo diario. */}
      <details className="group surface-card mt-8 overflow-hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <span className="min-w-0">
            <span className="block text-body font-semibold text-primary">
              {t('merchant.settingsTitle')}
            </span>
            <span className="mt-0.5 block text-sm text-tertiary">
              {t('merchant.settingsBody')}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-tertiary transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-3 border-t border-border p-4 sm:p-5">
          <SettingsSection id="identidad" icon={StoreIcon} title={t('merchant.identityHeading')}>
            {canEditIdentity ? (
              <StoreIdentityForm
                storeId={storeId}
                initialName={store.name}
                initialSlug={store.slug}
              />
            ) : (
              <div className="rounded-xl border border-border bg-background p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[2px] text-muted">
                  {t('merchant.identityPublicAddress')}
                </p>
                <p className="mt-1 break-all font-mono text-body text-primary">
                  {publicStoreUrl(store.slug)}
                </p>
                <p className="mt-1 text-sm text-tertiary">{t('merchant.identityLocked')}</p>
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            id="whatsapp"
            icon={MessageCircle}
            title={t('merchant.whatsappHeading')}
            description={t('merchant.whatsappBody')}
          >
            <StoreWhatsAppForm storeId={storeId} initialPhone={store.whatsapp} />
          </SettingsSection>

          <SettingsSection
            id="horario"
            icon={Clock}
            title={t('merchant.hoursHeading')}
            description={t('merchant.hoursBody')}
          >
            <StoreHoursForm storeId={storeId} initialHours={hours} />
          </SettingsSection>

          {status.missing === 'location' && (
            <SettingsSection
              id="ubicacion"
              icon={MapPin}
              title={t('merchant.locationTitle')}
              description={t('merchant.incompleteNotice')}
              tone="warning"
            >
              <p className="text-sm leading-relaxed text-secondary">
                {t('merchant.locationBody')}
              </p>
              <div className="mt-3">
                <StoreLocationForm storeId={storeId} />
              </div>
            </SettingsSection>
          )}

          {status.hasLocation && (
            <SettingsSection
              id="ubicacion"
              icon={MapPin}
              title={t('merchant.locationHeading')}
              description={t('merchant.locationBody')}
            >
              <div className="rounded-xl border border-border bg-background p-4">
                <p className="text-body font-medium text-primary">
                  {store.address ?? t('merchant.locationNoAddress')}
                </p>
                <p className="mt-1 text-sm text-tertiary">
                  {[store.district, store.province, store.department]
                    .filter(Boolean)
                    .join(' · ') || t('merchant.locationNoUbigeo')}
                </p>
              </div>
              <details className="mt-3">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-secondary underline-offset-2 hover:text-primary hover:underline">
                  {t('merchant.changeLocation')}
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
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
            </SettingsSection>
          )}

          {billing && <StoreBilling storeId={storeId} initialBilling={billing} />}
        </div>
      </details>
    </main>
  );
}
