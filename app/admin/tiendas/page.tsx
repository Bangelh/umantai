'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import { AdminNav } from '../components/AdminNav';

/**
 * /admin/tiendas — alta de comercios.
 *
 * El correo de "tu tienda ya existe" le promete al comerciante que un
 * administrador la va a revisar y activar. Hasta ahora esa revisión sólo se podía
 * hacer por API: no había ninguna pantalla. Esta es esa pantalla, mínima.
 *
 * Reglas de operación:
 *   · Activar publica la tienda (aparece en buscador y home).
 *   · Desactivar la oculta, pero NO toca pedidos en curso ni stock.
 *   · Ambas acciones piden confirmación con el nombre de la tienda: son las dos
 *     únicas acciones de la pantalla y una de ellas afecta a un tercero.
 */

type Filter = 'all' | 'pending' | 'active';

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  active: boolean;
  district: string | null;
  city: string | null;
  createdAt: string | null;
  memberCount: number;
  productCount: number;
  ownerEmail: string | null;
}

/** Petición pura: no toca estado de React (la usan el efecto y el reintento). */
async function requestStores(): Promise<StoreRow[]> {
  const response = await fetch('/api/admin/stores', withAdminAuth());
  if (!response.ok) throw new Error('stores');
  const payload = (await response.json().catch(() => null)) as { stores?: StoreRow[] } | null;
  return payload?.stores ?? [];
}

export default function AdminStoresPage() {
  const { t } = useI18n();
  const admin = usePlatformAdminSession();

  const [stores, setStores] = useState<StoreRow[] | null>(null);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setError(false);
    try {
      setStores(await requestStores());
    } catch {
      setError(true);
    }
  }, []);

  // Carga inicial al activarse la sesión. El estado se aplica en el callback de
  // la promesa (nunca de forma síncrona dentro del efecto).
  useEffect(() => {
    if (admin.status !== 'authenticated') return;
    let cancelled = false;
    void requestStores()
      .then((rows) => {
        if (!cancelled) setStores(rows);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [admin.status]);

  const toggle = useCallback(
    async (store: StoreRow) => {
      const nextActive = !store.active;
      const message = nextActive
        ? t('adminStores.activateConfirm', { store: store.name })
        : t('adminStores.deactivateConfirm', { store: store.name });
      if (!window.confirm(message)) return;

      setBusyId(store.id);
      setActionError(null);
      try {
        const response = await fetch(
          '/api/admin/stores',
          withAdminAuth({
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storeId: store.id, active: nextActive }),
          }),
        );
        const payload = (await response.json().catch(() => null)) as
          | { store?: { active?: boolean }; error?: string }
          | null;

        if (!response.ok) {
          setActionError(payload?.error ?? t('common.error'));
          return;
        }

        setStores((current) =>
          (current ?? []).map((row) =>
            row.id === store.id ? { ...row, active: payload?.store?.active ?? nextActive } : row,
          ),
        );
      } catch {
        setActionError(t('common.error'));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (stores ?? []).filter((store) => {
      if (filter === 'pending' && store.active) return false;
      if (filter === 'active' && !store.active) return false;
      if (!term) return true;
      return [store.name, store.slug, store.ownerEmail ?? ''].some((value) =>
        value.toLowerCase().includes(term),
      );
    });
  }, [stores, filter, query]);

  if (admin.status !== 'authenticated') {
    return <AdminAccessScreen title={t('adminStores.title')} status={admin.status} onActivate={admin.activate} />;
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <header>
        <p className="text-xs uppercase tracking-[2px] text-muted">{t('adminStores.kicker')}</p>
        <h1 className="mt-1 text-title font-semibold tracking-tight">{t('adminStores.title')}</h1>
        <p className="mt-2 max-w-2xl text-body text-secondary">{t('adminStores.subtitle')}</p>
      </header>

      <div className="mt-4 overflow-x-auto">
        <AdminNav />
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <label htmlFor="store-search" className="field-label">
            {t('common.search')}
          </label>
          <input
            id="store-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('adminStores.search')}
            className="field-input h-11"
          />
        </div>
        <div className="flex gap-2" role="group" aria-label={t('adminStores.status')}>
          {(
            [
              { id: 'all' as Filter, label: t('adminStores.filterAll') },
              { id: 'pending' as Filter, label: t('adminStores.filterPending') },
              { id: 'active' as Filter, label: t('adminStores.filterActive') },
            ]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`h-11 rounded-full px-4 text-sm font-medium transition-colors ${
                filter === item.id
                  ? 'bg-brand text-background'
                  : 'border border-border-strong text-secondary hover:bg-surface-raised hover:text-primary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-[15px] text-destructive"
        >
          {actionError}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-[15px] text-destructive"
        >
          <span>{t('adminStores.error')}</span>
          <button type="button" onClick={() => void load()} className="btn-secondary h-11 px-4 text-sm">
            {t('common.retry')}
          </button>
        </div>
      )}

      {!stores && !error && (
        <p role="status" className="mt-8 text-body text-tertiary">
          {t('adminStores.loading')}
        </p>
      )}

      {stores && (
        <>
          <p className="mt-5 text-sm text-tertiary">{t('adminStores.count', { count: filtered.length })}</p>

          {filtered.length === 0 ? (
            <p className="mt-2 rounded-2xl border border-border bg-surface p-6 text-center text-[15px] text-secondary">
              {stores.length === 0 ? t('adminStores.emptyAll') : t('adminStores.empty')}
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {filtered.map((store) => {
                const busy = busyId === store.id;
                return (
                  <li
                    key={store.id}
                    className="rounded-2xl border border-border bg-surface p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-body-lg font-semibold">{store.name}</h2>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                              store.active
                                ? 'border-success/40 bg-success/10 text-success'
                                : 'border-warning/40 bg-warning/10 text-warning'
                            }`}
                          >
                            {store.active ? t('adminStores.active') : t('adminStores.pending')}
                          </span>
                        </div>

                        <p className="mt-1 text-sm text-tertiary">
                          /{store.slug}
                          {[store.category, store.district, store.city].filter(Boolean).length > 0 &&
                            ` · ${[store.category, store.district, store.city].filter(Boolean).join(' · ')}`}
                        </p>

                        <p className="mt-1 text-sm text-secondary">
                          {t('adminStores.owner')}:{' '}
                          {store.ownerEmail ?? <span className="text-muted">{t('adminStores.noOwner')}</span>}
                          {' · '}
                          {t('adminStores.products')}: {store.productCount}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/${store.slug}`}
                          className="flex h-11 items-center rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised"
                        >
                          {t('adminStores.open')}
                        </Link>
                        <button
                          type="button"
                          onClick={() => void toggle(store)}
                          disabled={busy}
                          className={`h-11 rounded-xl px-4 text-sm font-semibold disabled:opacity-50 ${
                            store.active
                              ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
                              : 'bg-brand text-background'
                          }`}
                        >
                          {busy
                            ? store.active
                              ? t('adminStores.deactivating')
                              : t('adminStores.activating')
                            : store.active
                              ? t('adminStores.deactivate')
                              : t('adminStores.activate')}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
