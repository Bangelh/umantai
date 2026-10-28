'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import { AdminNav } from './components/AdminNav';

/**
 * /admin — entrada del Platform Admin.
 *
 * Antes esta ruta era el editor legacy del catálogo del template: un operador que
 * abría "Panel" veía precios en dólares de un catálogo que no es el marketplace,
 * textos técnicos ("Vercel Postgres", "Setup DB Tables") y todo en inglés.
 *
 * Ahora es lo que un operador necesita al entrar: qué está esperando una decisión
 * y a dónde ir. Sin métricas de vanidad, sin metadata de infraestructura.
 *
 * El editor legacy sigue disponible en /admin/productos, donde se nombra por lo
 * que realmente hace.
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
}

interface Summary {
  storesActive: number;
  storesPending: number;
  complaintsPending: number;
  ordersOperational: number;
  pendingStoreNames: string[];
}

const EMPTY: Summary = {
  storesActive: 0,
  storesPending: 0,
  complaintsPending: 0,
  ordersOperational: 0,
  pendingStoreNames: [],
};

async function fetchSummary(): Promise<Summary> {
  const [storesResponse, complaintsResponse, ordersResponse] = await Promise.all([
    fetch('/api/admin/stores', withAdminAuth()),
    fetch('/api/admin/complaints?status=received', withAdminAuth()),
    fetch('/api/admin/orders?limit=200', withAdminAuth()),
  ]);

  if (!storesResponse.ok) throw new Error('stores');

  const storesPayload = (await storesResponse.json().catch(() => null)) as
    | { stores?: StoreRow[] }
    | null;
  const stores = storesPayload?.stores ?? [];

  // Las reclamaciones se cuentan sin romper el panel si esa bandeja falla: una
  // sección caída no debe ocultar las tiendas por aprobar.
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

  const pending = stores.filter((store) => !store.active);

  return {
    storesActive: stores.length - pending.length,
    storesPending: pending.length,
    complaintsPending: complaints.filter((complaint) => complaint.status !== 'answered').length,
    ordersOperational: orders.length,
    pendingStoreNames: pending.slice(0, 3).map((store) => store.name),
  };
}

export default function AdminHomePage() {
  const { t } = useI18n();
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
          text: t('adminHome.storesItem', { count: data.storesPending }),
        }
      : null,
    data.complaintsPending > 0
      ? {
          key: 'complaints',
          href: '/admin/reclamaciones',
          text: t('adminHome.complaintsItem', { count: data.complaintsPending }),
        }
      : null,
    data.ordersOperational > 0
      ? {
          key: 'orders',
          href: '/admin/kiosco',
          text: t('adminHome.ordersItem', { count: data.ordersOperational }),
        }
      : null,
  ].filter((item): item is { key: string; href: string; text: string } => item !== null);

  const cards = [
    {
      href: '/admin/tiendas',
      value: data.storesActive,
      label: t('adminHome.storesActive'),
    },
    {
      href: '/admin/tiendas',
      value: data.storesPending,
      label: t('adminHome.storesPending'),
      highlight: data.storesPending > 0,
    },
    {
      href: '/admin/reclamaciones',
      value: data.complaintsPending,
      label: t('adminHome.complaintsPending'),
      highlight: data.complaintsPending > 0,
    },
    {
      href: '/admin/kiosco',
      value: data.ordersOperational,
      label: t('adminHome.operations'),
    },
  ];

  const shortcuts = [
    { href: '/admin/catalogo', label: t('adminNav.catalog') },
    { href: '/admin/inventario', label: t('adminNav.inventory') },
    { href: '/admin/analytics', label: t('adminNav.analytics') },
    { href: '/admin/planes', label: t('adminNav.plans') },
    { href: '/admin/kiosco', label: t('adminNav.kiosk') },
    { href: '/admin/productos', label: t('adminNav.siteCatalog') },
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

      <div className="mt-4 overflow-x-auto">
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
          <section aria-label={t('adminHome.title')} className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cards.map((card) => (
              <Link
                key={card.label}
                href={card.href}
                className={`rounded-2xl border p-4 transition-colors hover:bg-surface-raised ${
                  card.highlight ? 'border-warning/50 bg-warning/5' : 'border-border bg-surface'
                }`}
              >
                <span className="block font-mono text-4xl font-semibold tabular-nums">{card.value}</span>
                <span className="mt-1 block text-[15px] leading-snug text-secondary">{card.label}</span>
              </Link>
            ))}
          </section>

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

          <section className="mt-8">
            <h2 className="text-lg font-semibold">{t('adminHome.shortcuts')}</h2>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shortcuts.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="flex min-h-12 items-center rounded-xl border border-border-strong px-4 text-[15px] hover:bg-surface-raised"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
