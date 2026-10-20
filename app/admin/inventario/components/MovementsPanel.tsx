'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';
import { formatDateTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n/dictionaries';
import { withAdminAuth } from '@/lib/adminAuth';
import { INVENTORY_MOVEMENT_TYPES, type InventoryMovementType } from '@/lib/commerce';
import { catalogProducts } from './catalog-options';

interface LedgerEntry {
  id: string;
  productSlug: string;
  productName: string;
  variantKey: string;
  movementType: InventoryMovementType;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  orderNumber: string | null;
  reason: string | null;
  performedBy: string | null;
  createdAt: string;
}

interface LedgerResponse {
  ok?: boolean;
  entries?: LedgerEntry[];
  hasMore?: boolean;
  error?: string;
}

const PAGE_SIZE = 25;

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function MovementsPanel() {
  const { locale, t } = useI18n();
  const typeLabel = (type: InventoryMovementType) =>
    t(`inventory.movement.${type}` as MessageKey);
  const [productSlug, setProductSlug] = useState('');
  const [movementType, setMovementType] = useState('');
  const [order, setOrder] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const buildParams = useCallback(
    (offset: number) => {
      const params = new URLSearchParams();
      if (productSlug) params.set('product', productSlug);
      if (movementType) params.set('type', movementType);
      if (order.trim()) params.set('order', order.trim());
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      return params;
    },
    [from, movementType, order, productSlug, to],
  );

  /** Petición pura (sin setState): la usan el efecto de montaje y los handlers. */
  const requestLedger = useCallback(async (params: URLSearchParams) => {
    try {
      const response = await fetch(
        `/api/admin/inventory/ledger?${params.toString()}`,
        withAdminAuth(),
      );
      const payload = (await response.json().catch(() => null)) as LedgerResponse | null;
      if (!response.ok || !payload?.ok) {
        return {
          entries: [] as LedgerEntry[],
          hasMore: false,
          error: payload?.error ?? t('inventory.historyLoadFailed'),
        };
      }
      return {
        entries: payload.entries ?? [],
        hasMore: Boolean(payload.hasMore),
        error: null,
      };
    } catch {
      return {
        entries: [] as LedgerEntry[],
        hasMore: false,
        error: t('inventory.historyNetworkError'),
      };
    }
  }, [t]);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true);
      setError(null);
      const result = await requestLedger(buildParams(offset));
      if (result.error) setError(result.error);
      if (!result.error) {
        setEntries((current) => (append ? [...current, ...result.entries] : result.entries));
        setHasMore(result.hasMore);
      }
      setLoaded(true);
      setLoading(false);
    },
    [buildParams, requestLedger],
  );

  // Carga inicial sin filtros. El setState ocurre después del await, no en el
  // cuerpo síncrono del efecto.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
      const result = await requestLedger(params);
      if (cancelled) return;
      setEntries(result.entries);
      setHasMore(result.hasMore);
      setError(result.error);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestLedger]);

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    void load(0, false);
  };

  const resetFilters = () => {
    setProductSlug('');
    setMovementType('');
    setOrder('');
    setFrom('');
    setTo('');
  };

  const filtersDirty = Boolean(productSlug || movementType || order.trim() || from || to);

  return (
    <div>
      <form
        onSubmit={applyFilters}
        className="rounded-3xl border border-border bg-surface p-5"
        aria-label={t('inventory.movementsFilters')}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm">
            <span className="mb-1 block text-tertiary">{t('inventory.product')}</span>
            <select
              value={productSlug}
              onChange={(event) => setProductSlug(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
            >
              <option value="">{t('inventory.all')}</option>
              {catalogProducts.map((product) => (
                <option key={product.slug} value={product.slug}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-tertiary">{t('inventory.type')}</span>
            <select
              value={movementType}
              onChange={(event) => setMovementType(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
            >
              <option value="">{t('inventory.all')}</option>
              {INVENTORY_MOVEMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {typeLabel(type)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-tertiary">{t('inventory.order')}</span>
            <input
              value={order}
              onChange={(event) => setOrder(event.target.value)}
              placeholder={t('inventory.orderPlaceholder')}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-tertiary">{t('inventory.from')}</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-tertiary">{t('inventory.to')}</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="h-10 rounded-2xl bg-brand px-5 text-sm font-medium text-background disabled:opacity-50"
          >
            {loading ? t('inventory.searching') : t('inventory.applyFilters')}
          </button>
          {filtersDirty && (
            <button
              type="button"
              onClick={resetFilters}
              className="h-10 rounded-2xl border border-border-strong px-4 text-sm text-secondary hover:bg-surface-raised"
            >
              {t('inventory.clear')}
            </button>
          )}
        </div>
      </form>

      <div className="mt-5">
        {error && (
          <div role="alert" className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && entries.length === 0 && (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-14 animate-pulse rounded-2xl bg-surface-raised" />
            ))}
          </div>
        )}

        {!loading && loaded && entries.length === 0 && (
          <div className="rounded-3xl border border-dashed border-border p-10 text-center">
            <p className="text-lg font-medium">{t('inventory.noMovements')}</p>
            <p className="mt-1 text-sm text-tertiary">{t('inventory.noMovementsBody')}</p>
          </div>
        )}

        {entries.length > 0 && (
          <>
            <div className="hidden overflow-hidden rounded-3xl border border-border lg:block">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-left text-tertiary">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('inventory.date')}</th>
                    <th className="px-4 py-3 font-medium">{t('inventory.product')}</th>
                    <th className="px-4 py-3 font-medium">{t('inventory.type')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('inventory.onHand')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('inventory.reserved')}</th>
                    <th className="px-4 py-3 font-medium">{t('inventory.order')}</th>
                    <th className="px-4 py-3 font-medium">{t('inventory.actorReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-border align-top">
                      <td className="px-4 py-3 whitespace-nowrap text-secondary">
                        {formatDateTime(entry.createdAt, locale)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{entry.productName}</div>
                        <div className="text-xs text-muted">
                          {entry.variantKey || t('inventory.noVariant')}
                        </div>
                      </td>
                      <td className="px-4 py-3">{typeLabel(entry.movementType)}</td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div>{signed(entry.onHandDelta)}</div>
                        <div className="text-xs text-muted">
                          {t('inventory.balance', { value: entry.onHandAfter })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div>{signed(entry.reservedDelta) || '0'}</div>
                        <div className="text-xs text-muted">
                          {t('inventory.balance', { value: entry.reservedAfter })}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-secondary">
                        {entry.orderNumber ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-secondary">{entry.performedBy ?? '—'}</div>
                        {entry.reason && <div className="text-xs text-muted">{entry.reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {entries.map((entry) => (
                <div key={entry.id} className="rounded-2xl border border-border bg-surface p-4 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{entry.productName}</div>
                      <div className="text-xs text-muted">
                        {entry.variantKey || t('inventory.noVariant')}
                      </div>
                    </div>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                      {typeLabel(entry.movementType)}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-tertiary">
                    <div>
                      {t('inventory.onHand')}:{' '}
                      <span className="font-mono">{signed(entry.onHandDelta)}</span> →{' '}
                      {entry.onHandAfter}
                    </div>
                    <div>
                      {t('inventory.reserved')}:{' '}
                      <span className="font-mono">{signed(entry.reservedDelta) || '0'}</span> →{' '}
                      {entry.reservedAfter}
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted">
                    {formatDateTime(entry.createdAt, locale)}
                    {entry.orderNumber ? ` · ${entry.orderNumber}` : ''}
                    {entry.performedBy ? ` · ${entry.performedBy}` : ''}
                  </div>
                  {entry.reason && <div className="mt-1 text-xs text-tertiary">{entry.reason}</div>}
                </div>
              ))}
            </div>

            {hasMore && (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={() => void load(entries.length, true)}
                  disabled={loading}
                  className="h-11 rounded-2xl border border-border-strong px-6 text-sm hover:bg-surface-raised disabled:opacity-40"
                >
                  {loading ? t('inventory.loadingMore') : t('inventory.loadMore')}
                </button>
              </div>
            )}
          </>
        )}

        <p className="mt-4 text-xs text-muted">{t('inventory.appendOnly')}</p>
      </div>
    </div>
  );
}

