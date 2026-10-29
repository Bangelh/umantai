/**
 * /negocio — panel de comerciante: tiendas a las que pertenece el usuario.
 *
 * Si no hay sesión → login. Si hay sesión sin tiendas → CTA de alta.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user.server';
import { storeStatusLabel } from '@/lib/i18n/store-status';
import { getTranslator } from '@/lib/i18n/server';
import { resolveMerchantStoreStatus } from '@/lib/store-status';
import { listStoresForUser } from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return { title: t('merchant.myStores'), robots: { index: false, follow: false } };
}

export default async function MerchantHomePage() {
  const { t } = await getTranslator();
  const user = await getCurrentUser();
  if (!user) redirect('/ingresar?next=/negocio');

  const stores = await listStoresForUser(user.id);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 pt-6 sm:px-6">
      <div className="border-b border-border pb-4">
        <p className="text-xs uppercase tracking-[2px] text-muted">{t('merchant.homeKicker')}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('merchant.myStores')}</h1>
        <p className="mt-1 text-sm text-tertiary">{t('merchant.multiStoreHint')}</p>
      </div>

      {stores.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-lg font-semibold">{t('merchant.noStoreTitle')}</h2>
          <p className="mt-1 text-sm text-secondary">{t('merchant.noStoreBody')}</p>
          <Link
            href="/vender"
            className="mt-4 inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-semibold text-background"
          >
            {t('merchant.createStore')}
          </Link>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {stores.map((store) => {
            const status = resolveMerchantStoreStatus(store);
            return (
              <li key={store.id}>
                <Link
                  href={`/negocio/${store.id}`}
                  className="flex items-start justify-between gap-3 py-4 hover:bg-surface-raised/60"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-base font-medium">{store.name}</span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-tertiary">
                        {store.role}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-tertiary">
                      {t('merchant.storeMeta', {
                        slug: store.slug,
                        products: store.productCount,
                        orders: store.orderCount,
                      })}
                    </span>
                    {status.state === 'incomplete' && (
                      <span className="mt-1 block text-xs text-warning">
                        {t('merchant.incompleteNotice')}
                      </span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${
                      status.state === 'active' ? 'text-success' : 'text-warning'
                    }`}
                  >
                    {storeStatusLabel(t, status.state)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {stores.length > 0 && (
        <Link
          href="/vender"
          className="mt-5 inline-flex h-10 items-center rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
        >
          {t('merchant.addAnotherStore')}
        </Link>
      )}
    </main>
  );
}
