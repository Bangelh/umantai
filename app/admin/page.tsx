'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Boxes,
  ChevronRight,
  Clock,
  CreditCard,
  Globe,
  Library,
  MessageSquare,
  Monitor,
  Store,
  TrendingUp,
  Wrench,
} from 'lucide-react';

import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { SpotlightSurface } from '@/components/ui/SpotlightSurface';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import { formatMoney } from '@/lib/format';
import { AdminNav } from './components/AdminNav';

/**
 * /admin — portada del panel de la plataforma.
 *
 * Es el panel de los dueños de UMANTAI, no el de cada comerciante (ese es
 * /negocio) ni el de la operaria del kiosco (la tablet abre /admin/kiosco).
 *
 * La portada responde tres preguntas, en este orden:
 *   1. ¿Cómo va el negocio?  → ventas de los últimos 30 días.
 *   2. ¿Qué espera una decisión? → tiendas por aprobar, reclamos, pedidos.
 *   3. ¿A dónde voy? → accesos grandes con ícono; lo técnico queda en Herramientas.
 */

/** Hora de Lima, la única zona en la que opera el negocio. */
function clockLabel(iso: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Lima',
  }).format(new Date(iso));
}

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  productCount: number;
}

interface ComplaintRow {
  id: string;
  status: string;
  overdue?: boolean;
}

interface OrderRow {
  id: string;
  status: string;
}

interface SalesRow {
  revenueCents: number;
  orders: number;
  allOrders: number;
}

interface SubscriptionRow {
  status: string;
  plan: { code: string; priceCents: number };
}

interface Summary {
  storesActive: number;
  storesPending: number;
  complaintsPending: number;
  ordersReady: number;
  pendingStoreNames: string[];
  /** Tiendas con una suscripción paga activa y su ingreso mensual. */
  paidStores: number;
  mrrCents: number;
  /** `null` si el resumen de ventas no respondió: no se inventa un cero. */
  sales: SalesRow | null;
}

const EMPTY: Summary = {
  storesActive: 0,
  storesPending: 0,
  complaintsPending: 0,
  ordersReady: 0,
  pendingStoreNames: [],
  paidStores: 0,
  mrrCents: 0,
  sales: null,
};

/** Pedidos que ya están pagados y todavía no salieron de la tienda. */
const READY_STATUSES = new Set(['confirmed', 'preparing', 'ready_for_pickup']);

async function fetchSummary(): Promise<Summary> {
  const [storesResponse, complaintsResponse, ordersResponse, salesResponse, subsResponse] =
    await Promise.all([
      fetch('/api/admin/stores', withAdminAuth()),
      fetch('/api/admin/complaints?status=received', withAdminAuth()),
      fetch('/api/admin/orders?limit=200', withAdminAuth()),
      fetch('/api/admin/analytics/summary?range=30d', withAdminAuth()),
      fetch('/api/admin/billing/subscriptions', withAdminAuth()),
    ]);

  if (!storesResponse.ok) throw new Error('stores');

  const storesPayload = (await storesResponse.json().catch(() => null)) as
    | { stores?: StoreRow[] }
    | null;
  const stores = storesPayload?.stores ?? [];

  // Cada bandeja es independiente: si una falla, el resto sigue visible.
  let complaints: ComplaintRow[] = [];
  if (complaintsResponse.ok) {
    const payload = (await complaintsResponse.json().catch(() => null)) as
      | { complaints?: ComplaintRow[] }
      | null;
    complaints = payload?.complaints ?? [];
  }

  let orders: OrderRow[] = [];
  if (ordersResponse.ok) {
    const payload = (await ordersResponse.json().catch(() => null)) as
      | { orders?: OrderRow[] }
      | null;
    orders = payload?.orders ?? [];
  }

  let sales: SalesRow | null = null;
  if (salesResponse.ok) {
    const payload = (await salesResponse.json().catch(() => null)) as
      | { ok?: boolean; sales?: SalesRow }
      | null;
    if (payload?.ok && payload.sales) {
      sales = {
        revenueCents: payload.sales.revenueCents,
        orders: payload.sales.orders,
        allOrders: payload.sales.allOrders,
      };
    }
  }

  let paidStores = 0;
  let mrrCents = 0;
  if (subsResponse.ok) {
    const payload = (await subsResponse.json().catch(() => null)) as
      | { subscriptions?: SubscriptionRow[] }
      | null;
    const paid = (payload?.subscriptions ?? []).filter(
      (row) => row.status === 'active' && row.plan.code !== 'free',
    );
    paidStores = paid.length;
    mrrCents = paid.reduce((sum, row) => sum + row.plan.priceCents, 0);
  }

  const pending = stores.filter((store) => !store.active);

  return {
    storesActive: stores.length - pending.length,
    storesPending: pending.length,
    complaintsPending: complaints.filter((complaint) => complaint.status !== 'answered').length,
    ordersReady: orders.filter((order) => READY_STATUSES.has(order.status)).length,
    pendingStoreNames: pending.slice(0, 3).map((store) => store.name),
    paidStores,
    mrrCents,
    sales,
  };
}

export default function AdminHomePage() {
  const { t, locale } = useI18n();
  const admin = usePlatformAdminSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const next = await fetchSummary();
      setSummary(next);
      setUpdatedAt(new Date().toISOString());
    } catch {
      setError(true);
    }
  }, []);

  // Carga inicial al activarse la sesión. El estado se aplica en el callback de
  // la promesa, no sincrónicamente dentro del efecto.
  useEffect(() => {
    if (admin.status !== 'authenticated') return;
    let cancelled = false;
    void fetchSummary()
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        setUpdatedAt(new Date().toISOString());
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [admin.status]);

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen title={t('adminHome.title')} status={admin.status} onActivate={admin.activate} />
    );
  }

  const data = summary ?? EMPTY;
  const attention = [
    data.storesPending > 0
      ? {
          key: 'stores',
          href: '/admin/tiendas',
          text:
            data.storesPending === 1
              ? t('adminHome.storesItemOne')
              : t('adminHome.storesItem', { count: data.storesPending }),
        }
      : null,
    data.complaintsPending > 0
      ? {
          key: 'complaints',
          href: '/admin/reclamaciones',
          text:
            data.complaintsPending === 1
              ? t('adminHome.complaintsItemOne')
              : t('adminHome.complaintsItem', { count: data.complaintsPending }),
        }
      : null,
    data.ordersReady > 0
      ? {
          key: 'orders',
          href: '/admin/kiosco',
          text:
            data.ordersReady === 1
              ? t('adminHome.ordersItemOne')
              : t('adminHome.ordersItem', { count: data.ordersReady }),
        }
      : null,
  ].filter((item): item is { key: string; href: string; text: string } => item !== null);

  const cards = [
    { href: '/admin/tiendas', value: data.storesActive, label: t('adminHome.storesActive'), icon: Store },
    {
      href: '/admin/tiendas',
      value: data.storesPending,
      label: t('adminHome.storesPending'),
      icon: Clock,
      highlight: data.storesPending > 0,
    },
    { href: '/admin/kiosco', value: data.ordersReady, label: t('adminHome.readyOrders'), icon: Boxes },
    {
      href: '/admin/reclamaciones',
      value: data.complaintsPending,
      label: t('adminHome.complaintsPending'),
      icon: MessageSquare,
      highlight: data.complaintsPending > 0,
    },
  ];

  const actions = [
    {
      href: '/admin/tiendas',
      icon: Store,
      label: t('adminHome.actionStores'),
      hint: t('adminHome.actionStoresHint'),
    },
    {
      href: '/admin/reclamaciones',
      icon: MessageSquare,
      label: t('adminHome.actionComplaints'),
      hint: t('adminHome.actionComplaintsHint'),
    },
    {
      href: '/admin/kiosco',
      icon: Monitor,
      label: t('adminHome.actionOrders'),
      hint: t('adminHome.actionOrdersHint'),
    },
    {
      href: '/admin/analytics',
      icon: TrendingUp,
      label: t('adminHome.actionSales'),
      hint: t('adminHome.actionSalesHint'),
    },
  ];

  const tools = [
    { href: '/admin/catalogo', icon: Library, label: t('adminNav.catalog') },
    { href: '/admin/productos', icon: Globe, label: t('adminNav.siteCatalog') },
    { href: '/admin/inventario', icon: Boxes, label: t('adminNav.inventory') },
    { href: '/admin/planes', icon: CreditCard, label: t('adminNav.plans') },
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[2px] text-muted">{t('adminHome.kicker')}</p>
          <h1 className="mt-1 text-title font-semibold tracking-tight">{t('adminHome.title')}</h1>
          <p className="mt-2 max-w-2xl text-body text-secondary">{t('adminHome.subtitle')}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => void load()}
            className="btn-secondary h-11 px-4 text-sm"
          >
            {t('adminHome.refresh')}
          </button>
          {updatedAt && (
            <span className="text-xs text-muted">
              {t('adminHome.updated', { time: clockLabel(updatedAt) })}
            </span>
          )}
        </div>
      </header>

      <div className="mt-4">
        <AdminNav />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-[15px] text-destructive"
        >
          <span>{t('adminHome.error')}</span>
          <button type="button" onClick={() => void load()} className="btn-secondary h-11 px-4 text-sm">
            {t('common.retry')}
          </button>
        </div>
      )}

      {!summary && !error ? (
        <p role="status" className="mt-8 text-body text-tertiary">
          {t('adminHome.loading')}
        </p>
      ) : (
        <>
          {/* Cómo va el negocio */}
          <SpotlightSurface className="mt-6 rounded-2xl border border-brand/40 bg-brand/5">
          <Link
            href="/admin/analytics"
            className="block p-5 transition-colors hover:bg-brand/10"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 text-sm text-secondary">
                  <TrendingUp className="h-4 w-4" aria-hidden="true" />
                  {t('adminHome.salesTitle')}
                </p>
                <p className="mt-2 font-mono text-4xl font-semibold tabular-nums sm:text-5xl">
                  {data.sales ? formatMoney(data.sales.revenueCents, 'PEN', locale) : '—'}
                </p>
                <p className="mt-1 text-sm text-secondary">
                  {data.sales
                    ? data.sales.orders > 0
                      ? t('adminHome.salesOrders', { count: data.sales.orders })
                      : t('adminHome.salesEmpty')
                    : t('adminHome.salesUnavailable')}
                </p>
              </div>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-brand">
                {t('adminHome.openSales')}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <p className="mt-3 text-xs text-tertiary">{t('adminHome.salesRule')}</p>
          </Link>
          </SpotlightSurface>

          <Link
            href="/admin/planes"
            className="mt-3 grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-4 transition-colors hover:bg-surface-raised"
          >
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{t('adminPlans.paidStores')}</p>
              <p className="mt-1 font-mono text-3xl font-semibold tabular-nums">{data.paidStores}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{t('adminPlans.mrr')}</p>
              <p className="mt-1 font-mono text-3xl font-semibold tabular-nums">
                {formatMoney(data.mrrCents, 'USD', locale)}
              </p>
            </div>
          </Link>

          {/* Números que importan */}
          <section aria-label={t('adminHome.attention')} className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cards.map((card) => {
              const Icon = card.icon;
              return (
                <Link
                  key={card.label}
                  href={card.href}
                  className={`rounded-2xl border p-4 transition-colors hover:bg-surface-raised ${
                    card.highlight ? 'border-warning/50 bg-warning/5' : 'border-border bg-surface'
                  }`}
                >
                  <Icon className="h-5 w-5 text-tertiary" aria-hidden="true" />
                  <span className="mt-2 block font-mono text-4xl font-semibold tabular-nums">
                    {card.value}
                  </span>
                  <span className="mt-1 block text-[15px] leading-snug text-secondary">{card.label}</span>
                </Link>
              );
            })}
          </section>

          {/* Qué espera una decisión */}
          <section className="mt-8">
            <h2 className="text-lg font-semibold">{t('adminHome.attention')}</h2>
            {attention.length === 0 ? (
              <p className="mt-2 rounded-2xl border border-border bg-surface p-4 text-[15px] text-secondary">
                {t('adminHome.allClear')}
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-2xl border border-border bg-surface">
                {attention.map((item) => (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 text-[15px] hover:bg-surface-raised"
                    >
                      <span>{item.text}</span>
                      <span aria-hidden="true" className="text-tertiary">
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {data.pendingStoreNames.length > 0 && (
              <p className="mt-2 text-sm text-tertiary">
                {data.pendingStoreNames.join(' · ')}
                {data.storesPending > data.pendingStoreNames.length ? ' …' : ''}
              </p>
            )}
          </section>

          {/* A dónde voy */}
          <section className="mt-8">
            <h2 className="text-lg font-semibold">{t('adminHome.quickActions')}</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="flex min-h-20 items-center gap-4 rounded-2xl border border-border-strong px-4 py-3 transition-colors hover:bg-surface-raised"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium leading-snug">{action.label}</span>
                      <span className="mt-0.5 block text-xs text-tertiary">{action.hint}</span>
                    </span>
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </section>

          {/* Lo técnico, fuera del camino */}
          <details className="mt-8 rounded-2xl border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[15px] font-medium">
              <Wrench className="h-4 w-4 text-tertiary" aria-hidden="true" />
              {t('adminHome.tools')}
              <span className="ml-auto text-xs font-normal text-tertiary">{t('adminHome.toolsHint')}</span>
            </summary>
            <div className="grid grid-cols-2 gap-2 border-t border-border p-3 sm:grid-cols-4">
              {tools.map((tool) => {
                const Icon = tool.icon;
                return (
                  <Link
                    key={tool.href}
                    href={tool.href}
                    className="flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm hover:bg-surface-raised"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
                    <span className="truncate">{tool.label}</span>
                  </Link>
                );
              })}
            </div>
          </details>
        </>
      )}
    </main>
  );
}
