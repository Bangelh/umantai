/**
 * /negocio — panel de comerciante: tiendas a las que pertenece el usuario.
 *
 * Si no hay sesión → login. Si hay sesión sin tiendas → CTA de alta.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user.server';
import { listStoresForUser } from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Mi negocio',
  robots: { index: false, follow: false },
};

export default async function MerchantHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/ingresar?next=/negocio');

  const stores = await listStoresForUser(user.id);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 pt-6 sm:px-6">
      <div className="border-b border-border pb-4">
        <p className="text-xs uppercase tracking-[2px] text-muted">Comerciante</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Mis tiendas</h1>
        <p className="mt-1 text-sm text-tertiary">
          Una cuenta puede administrar varias tiendas. Cada panel ve SOLO los datos de su tienda.
        </p>
      </div>

      {stores.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-lg font-semibold">Todavía no tienes una tienda</h2>
          <p className="mt-1 text-sm text-secondary">
            Publica tu catálogo, gestiona pedidos e inventario desde UMANTAI.
          </p>
          <Link
            href="/vender"
            className="mt-4 inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-semibold text-background"
          >
            Crear mi tienda
          </Link>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {stores.map((store) => (
            <li key={store.id}>
              <Link
                href={`/negocio/${store.id}`}
                className="flex items-center justify-between gap-3 py-4 hover:bg-surface-raised/60"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-base font-medium">{store.name}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-tertiary">
                      {store.role}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-tertiary">
                    /{store.slug} · {store.productCount} productos · {store.orderCount} pedidos
                  </span>
                </span>
                <span className={`shrink-0 text-xs ${store.active ? 'text-success' : 'text-warning'}`}>
                  {store.active ? 'Activa' : 'Pendiente'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {stores.length > 0 && (
        <Link
          href="/vender"
          className="mt-5 inline-flex h-10 items-center rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
        >
          + Agregar otra tienda
        </Link>
      )}
    </main>
  );
}
