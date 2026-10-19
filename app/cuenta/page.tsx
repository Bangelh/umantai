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
import { ORDER_STATUS_LABELS } from '@/lib/analytics';
import { getCurrentUser } from '@/lib/current-user.server';
import { formatPriceCents } from '@/lib/discovery';
import { getCustomerProfile, listCustomerOrders, listStoresForUser } from '@/lib/stores.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Mi cuenta',
  robots: { index: false, follow: false },
};

function formatDate(value: string): string {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: 'America/Lima' }).format(
      new Date(value),
    );
  } catch {
    return value.slice(0, 10);
  }
}

export default async function AccountPage() {
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
          <p className="text-xs uppercase tracking-[2px] text-muted">Cuenta</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Hola, {user.name.split(' ')[0]}</h1>
          <p className="mt-1 text-sm text-tertiary">{user.email}</p>
        </div>
        <SignOutButton />
      </div>

      {/* Negocios */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Tus negocios</h2>
          <Link href="/vender" className="text-xs text-tertiary hover:text-primary">
            + Crear tienda
          </Link>
        </div>

        {stores.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-border bg-surface p-4">
            <p className="text-sm text-secondary">
              Todavía no administras ninguna tienda. Puedes vender en UMANTAI con la misma cuenta.
            </p>
            <Link
              href="/vender"
              className="mt-3 inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-background"
            >
              Quiero vender
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
                      /{store.slug} · {store.productCount} productos · {store.orderCount} pedidos
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-tertiary">
                    {store.active ? (
                      <span className="text-success">Activa</span>
                    ) : (
                      <span className="text-warning">Pendiente</span>
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
          Datos personales
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

      {/* Historial */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Tus pedidos</h2>
          <span className="text-xs text-muted tabular-nums">{orders.length}</span>
        </div>

        {orders.length === 0 ? (
          <p className="py-5 text-sm text-tertiary">
            Aún no tienes pedidos asociados a tu cuenta. Las compras como invitado no se muestran
            aquí hasta que exista verificación de correo.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((order) => (
              <li key={order.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono text-sm">{order.orderNumber}</span>
                      <span className="text-xs text-tertiary">{formatDate(order.createdAt)}</span>
                      <span className="text-xs text-secondary">
                        {(ORDER_STATUS_LABELS as Record<string, string>)[order.status] ?? order.status}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-tertiary">
                      {order.storeName ? `${order.storeName} · ` : ''}
                      {order.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm font-semibold tabular-nums">
                      {formatPriceCents(Math.round(order.total * 100), order.currency)}
                    </div>
                    {order.publicToken && (
                      <Link
                        href={`/pedido/${order.publicToken}`}
                        className="text-xs text-tertiary underline-offset-2 hover:text-primary hover:underline"
                      >
                        Ver detalle
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
