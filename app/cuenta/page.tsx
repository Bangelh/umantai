/**
 * /cuenta — cuenta de cliente.
 *
 * · Perfil básico (nombre, teléfono, documento).
 * · Historial de pedidos asociados a la identidad (`orders.user_id`).
 * · Si el usuario también es comerciante, accesos directos a sus tiendas.
 *
 * No hay features sociales ni fidelización en esta fase.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ProfileForm } from './ProfileForm';
import { SignOutButton } from './SignOutButton';
import { SecurityPanel } from './SecurityPanel';
import { orderStatusLabel } from '@/lib/i18n/status';
import { getCurrentUser } from '@/lib/current-user.server';
import { getCustomerProfile, listCustomerOrders, listStoresForUser } from '@/lib/stores.server';
import { getTranslator } from '@/lib/i18n/server';
import { formatDate as formatDateLocale, formatMoney, unitsToCents } from '@/lib/format';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
    title: t('account.kicker'),
    robots: { index: false, follow: false },
  };
}

export default async function AccountPage() {
  const { locale, t } = await getTranslator();
  const user = await getCurrentUser();
  if (!user) redirect('/ingresar?next=/cuenta');

  const [profile, orders, stores] = await Promise.all([
    getCustomerProfile(user.id),
    listCustomerOrders(user.id),
    listStoresForUser(user.id),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 pt-6 sm:px-6">
      <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-xs uppercase tracking-[2px] text-muted">{t('account.kicker')}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {t('account.greeting', { name: user.name.split(' ')[0] })}
          </h1>
          <p className="mt-1 text-sm text-tertiary">{user.email}</p>
          <p className="mt-1 text-xs text-muted">
            {user.emailVerified ? t('account.emailVerified') : t('account.emailUnverified')}
          </p>
        </div>
        <SignOutButton />
      </div>

      {/* Negocios */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('account.businesses')}
          </h2>
          <Link href="/vender" className="text-xs text-tertiary hover:text-primary">
            {t('account.createStore')}
          </Link>
        </div>

        {stores.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-border bg-surface p-4">
            <p className="text-sm text-secondary">{t('account.noStores')}</p>
            <Link
              href="/vender"
              className="mt-3 inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-background"
            >
              {t('account.wantSell')}
            </Link>
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {stores.map((store) => (
              <li key={store.id}>
                <Link
                  href={`/negocio/${store.id}`}
                  className="flex items-center justify-between gap-3 py-3 hover:bg-surface-raised/60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{store.name}</span>
                    <span className="block truncate text-xs text-tertiary">
                      /{store.slug} ·{' '}
                      {t('account.productsOrders', {
                        products: store.productCount,
                        orders: store.orderCount,
                      })}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-tertiary">
                    {store.active ? (
                      <span className="text-success">{t('account.active')}</span>
                    ) : (
                      <span className="text-warning">{t('account.pending')}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Perfil */}
      <section className="mt-8">
        <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
          {t('account.profile')}
        </h2>
        <ProfileForm
          initial={{
            fullName: profile?.fullName ?? user.name,
            phone: profile?.phone ?? '',
            docType: profile?.docType ?? '',
            docNumber: profile?.docNumber ?? '',
          }}
        />
      </section>

      {/* Seguridad */}
      <section className="mt-8">
        <h2 className="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[2px] text-secondary">
          {t('account.security')}
        </h2>
        <SecurityPanel />
      </section>

      {/* Historial */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('account.orders')}
          </h2>
          <span className="text-xs text-muted tabular-nums">{orders.length}</span>
        </div>

        {orders.length === 0 ? (
          <p className="py-5 text-sm text-tertiary">{t('account.noOrders')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((order) => (
              <li key={order.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono text-sm">{order.orderNumber}</span>
                      <span className="text-xs text-tertiary">
                        {formatDateLocale(order.createdAt, locale)}
                      </span>
                      <span className="text-xs text-secondary">
                        {orderStatusLabel(t, order.status)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-tertiary">
                      {order.storeName ? `${order.storeName} · ` : ''}
                      {order.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm font-semibold tabular-nums">
                      {formatMoney(unitsToCents(order.total), order.currency, locale)}
                    </div>
                    {order.publicToken && (
                      <Link
                        href={`/pedido/${order.publicToken}`}
                        className="text-xs text-tertiary underline-offset-2 hover:text-primary hover:underline"
                      >
                        {t('account.viewDetail')}
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
