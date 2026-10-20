'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import {
  EMPTY_INVENTORY_FILTERS,
  filterInventoryItems,
  summarizeInventory,
  type AdminInventoryItem,
  type InventoryFilters,
  type InventoryStatus,
} from '@/lib/inventory-admin';
import { InventoryTable } from './components/InventoryTable';
import { ReceiptForm } from './components/ReceiptForm';
import { AdjustmentForm } from './components/AdjustmentForm';
import { MovementsPanel } from './components/MovementsPanel';
import { AdminNav } from '../components/AdminNav';

type Tab = 'inventario' | 'movimientos';

interface InventoryPayload {
  ok?: boolean;
  items?: AdminInventoryItem[];
  lowStock?: AdminInventoryItem[];
  error?: string;
}

const ACTOR_STORAGE_KEY = 'umantai-inventory-actor';

export default function InventoryAdminPage() {
  const { t } = useI18n();
  const admin = usePlatformAdminSession();

  const [items, setItems] = useState<AdminInventoryItem[]>([]);
  const [lowStock, setLowStock] = useState<AdminInventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('inventario');

  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_INVENTORY_FILTERS);
  const [actor, setActor] = useState('admin');

  const rememberActor = (value: string) => {
    setActor(value);
    try {
      window.localStorage.setItem(ACTOR_STORAGE_KEY, value);
    } catch {
      /* queda en memoria */
    }
  };

  const applyPayload = useCallback((payload: InventoryPayload | null) => {
    if (!payload?.items) return;
    setItems(payload.items);
    setLowStock(payload.lowStock ?? []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/inventory', withAdminAuth());
      const payload = (await response.json().catch(() => null)) as InventoryPayload | null;
      if (!response.ok || !payload?.ok) {
        setError(payload?.error ?? t('inventory.loadFailed'));
        return;
      }
      applyPayload(payload);
    } catch {
      setError(t('inventory.networkError'));
    } finally {
      setLoading(false);
    }
  }, [applyPayload, t]);

  // Con sesión de Platform Admin activa, carga el inventario una vez.
  useEffect(() => {
    if (admin.status === 'authenticated') void load();
  }, [admin.status, load]);

  const summary = useMemo(() => summarizeInventory(items), [items]);
  const filtered = useMemo(() => filterInventoryItems(items, filters), [items, filters]);

  const onChanged = useCallback(
    async (message: string) => {
      toast.success(message);
      await load();
    },
    [load],
  );

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen
        title={t('inventory.title')}
        status={admin.status}
        onActivate={admin.activate}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 text-primary sm:p-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[3px] text-tertiary">{t('inventory.kicker')}</div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('inventory.title')}</h1>
            <p className="mt-1 text-sm text-tertiary">{t('inventory.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-tertiary">
              <span className="mr-2">{t('inventory.actor')}</span>
              <input
                value={actor}
                onChange={(event) => rememberActor(event.target.value)}
                maxLength={80}
                aria-label={t('inventory.actorAria')}
                className="h-9 w-40 rounded-xl border border-border-strong bg-surface px-3 text-sm text-primary"
              />
            </label>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface-raised"
            >
              {loading ? t('inventory.refreshing') : t('inventory.refresh')}
            </button>
          </div>
        </div>

        <div className="mt-4">
          <AdminNav />
        </div>

        <div className="mt-6 flex gap-2 border-b border-border" role="tablist" aria-label={t('inventory.tabsAria')}>
          {(['inventario', 'movimientos'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`-mb-px border-b-2 px-4 py-3 text-sm capitalize ${
                tab === value
                  ? 'border-brand text-primary'
                  : 'border-transparent text-tertiary hover:text-secondary'
              }`}
            >
              {value === 'inventario' ? t('inventory.tabStock') : t('inventory.tabMovements')}
            </button>
          ))}
        </div>

        {error && (
          <div role="alert" className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-destructive">
            {error}
          </div>
        )}

        {tab === 'inventario' ? (
          <div className="mt-6 space-y-6">
            <section aria-label={t('inventory.summaryAria')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <SummaryCard label={t('inventory.skus')} value={summary.skuCount} />
              <SummaryCard label={t('inventory.onHand')} value={summary.unitsOnHand} />
              <SummaryCard label={t('inventory.reserved')} value={summary.unitsReserved} />
              <SummaryCard label={t('inventory.low')} value={summary.lowCount} tone="amber" />
              <SummaryCard label={t('inventory.out')} value={summary.outCount} tone="red" />
            </section>

            {lowStock.length > 0 && (
              <div className="rounded-3xl border border-warning/40 bg-warning/10 p-5">
                <div className="text-xs uppercase tracking-widest text-warning">
                  {t('inventory.needsRestock', { count: lowStock.length })}
                </div>
                <ul className="mt-3 grid gap-1 text-sm text-secondary sm:grid-cols-2">
                  {lowStock.slice(0, 8).map((item) => (
                    <li key={`${item.productSlug}:${item.variantKey}`}>
                      {item.productName}
                      {item.variantKey ? ` (${item.variantKey})` : ''}:{' '}
                      <span className="font-mono">{item.quantityAvailable}</span>{' '}
                      {t('inventory.available').toLowerCase()}
                    </li>
                  ))}
                </ul>
                {lowStock.length > 8 && (
                  <p className="mt-2 text-xs text-warning/80">
                    {t('inventory.more', { count: lowStock.length - 8 })}
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              <ReceiptForm actor={actor} onSuccess={onChanged} />
              <AdjustmentForm actor={actor} onSuccess={onChanged} />
            </div>

            <section aria-label={t('inventory.listAria')}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-lg font-medium">{t('inventory.stockBySku')}</h2>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="search"
                    value={filters.q}
                    onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
                    placeholder={t('inventory.searchPlaceholder')}
                    aria-label={t('inventory.searchAria')}
                    className="h-10 w-full rounded-xl border border-border-strong bg-surface px-3 text-sm sm:w-72"
                  />
                  <select
                    value={filters.status}
                    onChange={(event) =>
                      setFilters((current) => ({
                        ...current,
                        status: event.target.value as InventoryStatus | 'all',
                      }))
                    }
                    aria-label={t('inventory.filterStatus')}
                    className="h-10 rounded-xl border border-border-strong bg-surface px-3 text-sm"
                  >
                    <option value="all">{t('inventory.allStatuses')}</option>
                    <option value="available">{t('inventory.available')}</option>
                    <option value="low">{t('inventory.low')}</option>
                    <option value="out">{t('inventory.out')}</option>
                  </select>
                </div>
              </div>

              <p className="mt-2 text-xs text-muted">
                {t('inventory.showing', { shown: filtered.length, total: items.length })}
              </p>

              <div className="mt-4">
                <InventoryTable items={filtered} loading={loading} onChanged={load} />
              </div>
            </section>
          </div>
        ) : (
          <div className="mt-6">
            <MovementsPanel />
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'red';
}) {
  const valueClass =
    tone === 'amber' ? 'text-warning' : tone === 'red' ? 'text-destructive' : 'text-primary';

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-widest text-muted">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${valueClass}`}>{value}</div>
    </div>
  );
}
