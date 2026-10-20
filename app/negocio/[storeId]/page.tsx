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
import { ORDER_STATUS_LABELS, resolveAnalyticsRange } from '@/lib/analytics';
import { getCurrentUser } from '@/lib/current-user.server';
import { formatPriceCents } from '@/lib/discovery';
import { getAnalyticsSummary } from '@/lib/analytics.server';
import { getStoreBillingForUser } from '@/lib/billing/subscriptions.server';
import {
  listStoreOrders,
  listStoreProducts,
  requireStoreAccess,
} from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Panel de tienda',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ storeId: string }>;
}

function formatDate(value: string): string {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' }).format(
      new Date(value),
    );
  } catch {
    return value.slice(0, 10);
  }
}

export default async function MerchantStorePage({ params }: PageProps) {
  const user = await getCurrentUser();
  const { storeId } = await params;
  if (!user) redirect(`/ingresar?next=/negocio/${storeId}`);

  let store;
  try {
    ({ store } = await requireStoreAccess(user.id, storeId));
  } catch {
    notFound();
  }

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

  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 pt-6 sm:px-6">
      <nav className="text-xs text-muted">
        <Link href="/negocio" className="hover:text-primary">Mis tiendas</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{store.name}</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{store.name}</h1>
          <p className="mt-1 text-sm text-tertiary">
            /{store.slug} · {store.category ?? 'Sin rubro'} ·{' '}
            <span className={store.active ? 'text-success' : 'text-warning'}>
              {store.active ? 'Activa' : 'Pendiente de aprobación'}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          {store.active ? (
            <Link
              href={`/${store.slug}`}
              className="inline-flex h-9 items-center rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised"
            >
              Ver vitrina
            </Link>
          ) : (
            <span className="inline-flex h-9 items-center rounded-xl border border-border px-3 text-xs text-tertiary">
              Vitrina oculta hasta la aprobación
            </span>
          )}
        </div>
      </header>

      {!store.active && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          La tienda todavía no es visible en el buscador. Un administrador de UMANTAI debe activarla.
          Puedes preparar el catálogo mientras tanto.
        </div>
      )}

      {billing && <StoreBilling storeId={storeId} initialBilling={billing} />}

      {/* KPIs */}
      <section aria-label="Resumen" className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Ventas 30d</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatPriceCents(sales?.revenueCents ?? 0, 'PEN')}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Pedidos</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{sales?.orders ?? 0}</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Ticket medio</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatPriceCents(sales?.averageTicketCents ?? 0, 'PEN')}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Stock bajo</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {summary ? summary.lowStock.length + summary.outOfStock.length : 0}
          </div>
        </div>
      </section>

      {/* Productos */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Productos</h2>
          <span className="text-xs text-muted tabular-nums">{products.length}</span>
        </div>

        <MerchantCatalog storeId={storeId} products={products} />
      </section>

      {/* Pedidos */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Pedidos</h2>
          <span className="text-xs text-muted tabular-nums">{orders.length}</span>
        </div>

        {orders.length === 0 ? (
          <p className="py-4 text-sm text-tertiary">Todavía no hay pedidos en esta tienda.</p>
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((order) => (
              <li key={order.id} className="py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-sm">{order.orderNumber}</span>
                      <span className="text-xs text-secondary">
                        {(ORDER_STATUS_LABELS as Record<string, string>)[order.status] ?? order.status}
                      </span>
                      <span className="text-xs text-muted">{formatDate(order.createdAt)}</span>
                    </div>
                    <p className="truncate text-xs text-tertiary">
                      {order.contactEmail} · {order.itemCount} art. ·{' '}
                      {order.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
                    </p>
                  </div>
                  <div className="shrink-0 font-mono text-sm font-semibold tabular-nums">
                    {formatPriceCents(Math.round(order.total * 100), order.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {summary && summary.topProducts.length > 0 && (
        <section className="mt-8">
          <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
            Más vendidos (30 días)
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {summary.topProducts.slice(0, 5).map((product) => (
              <li key={product.productSlug} className="flex justify-between gap-3">
                <span className="truncate text-secondary">{product.productName}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-tertiary">
                  {product.quantity} · {formatPriceCents(product.revenueCents, 'PEN')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
