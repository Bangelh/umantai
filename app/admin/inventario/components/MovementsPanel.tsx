'use client';

import { useCallback, useEffect, useState } from 'react';
import { withAdminAuth } from '@/lib/adminAuth';
import { MOVEMENT_TYPE_LABELS } from '@/lib/inventory-admin';
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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('es-PE');
}

export function MovementsPanel() {
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
          error: payload?.error ?? 'No se pudo cargar el historial.',
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
        error: 'Error de red al cargar el historial.',
      };
    }
  }, []);

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
        className="rounded-3xl border border-white/15 bg-neutral-900 p-5"
        aria-label="Filtros de movimientos"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm">
            <span className="mb-1 block text-white/60">Producto</span>
            <select
              value={productSlug}
              onChange={(event) => setProductSlug(event.target.value)}
              className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
            >
              <option value="">Todos</option>
              {catalogProducts.map((product) => (
                <option key={product.slug} value={product.slug}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-white/60">Tipo</span>
            <select
              value={movementType}
              onChange={(event) => setMovementType(event.target.value)}
              className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
            >
              <option value="">Todos</option>
              {INVENTORY_MOVEMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MOVEMENT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-white/60">Pedido</span>
            <input
              value={order}
              onChange={(event) => setOrder(event.target.value)}
              placeholder="UM-… o UUID"
              className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-white/60">Desde</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-white/60">Hasta</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="h-10 rounded-2xl bg-white px-5 text-sm font-medium text-black disabled:opacity-50"
          >
            {loading ? 'Buscando…' : 'Aplicar filtros'}
          </button>
          {filtersDirty && (
            <button
              type="button"
              onClick={resetFilters}
              className="h-10 rounded-2xl border border-white/20 px-4 text-sm text-white/70 hover:bg-white/5"
            >
              Limpiar
            </button>
          )}
        </div>
      </form>

      <div className="mt-5">
        {error && (
          <div role="alert" className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {loading && entries.length === 0 && (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-14 animate-pulse rounded-2xl bg-white/5" />
            ))}
          </div>
        )}

        {!loading && loaded && entries.length === 0 && (
          <div className="rounded-3xl border border-dashed border-white/15 p-10 text-center">
            <p className="text-lg font-medium">Sin movimientos para esos filtros.</p>
            <p className="mt-1 text-sm text-white/50">
              Prueba con otro producto, tipo o rango de fechas.
            </p>
          </div>
        )}

        {entries.length > 0 && (
          <>
            <div className="hidden overflow-hidden rounded-3xl border border-white/15 lg:block">
              <table className="w-full text-sm">
                <thead className="bg-white/5 text-left text-white/60">
                  <tr>
                    <th className="px-4 py-3 font-medium">Fecha</th>
                    <th className="px-4 py-3 font-medium">Producto</th>
                    <th className="px-4 py-3 font-medium">Tipo</th>
                    <th className="px-4 py-3 text-right font-medium">Físico</th>
                    <th className="px-4 py-3 text-right font-medium">Reservado</th>
                    <th className="px-4 py-3 font-medium">Pedido</th>
                    <th className="px-4 py-3 font-medium">Actor / motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-white/10 align-top">
                      <td className="px-4 py-3 whitespace-nowrap text-white/70">{formatDate(entry.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{entry.productName}</div>
                        <div className="text-xs text-white/45">{entry.variantKey || 'sin variante'}</div>
                      </td>
                      <td className="px-4 py-3">{MOVEMENT_TYPE_LABELS[entry.movementType]}</td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div>{signed(entry.onHandDelta)}</div>
                        <div className="text-xs text-white/45">saldo {entry.onHandAfter}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div>{signed(entry.reservedDelta) || '0'}</div>
                        <div className="text-xs text-white/45">saldo {entry.reservedAfter}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-white/70">
                        {entry.orderNumber ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-white/70">{entry.performedBy ?? '—'}</div>
                        {entry.reason && <div className="text-xs text-white/45">{entry.reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {entries.map((entry) => (
                <div key={entry.id} className="rounded-2xl border border-white/15 bg-neutral-900 p-4 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{entry.productName}</div>
                      <div className="text-xs text-white/45">{entry.variantKey || 'sin variante'}</div>
                    </div>
                    <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs">
                      {MOVEMENT_TYPE_LABELS[entry.movementType]}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/60">
                    <div>Físico: <span className="font-mono">{signed(entry.onHandDelta)}</span> → {entry.onHandAfter}</div>
                    <div>Reservado: <span className="font-mono">{signed(entry.reservedDelta) || '0'}</span> → {entry.reservedAfter}</div>
                  </div>
                  <div className="mt-2 text-xs text-white/45">
                    {formatDate(entry.createdAt)}
                    {entry.orderNumber ? ` · ${entry.orderNumber}` : ''}
                    {entry.performedBy ? ` · ${entry.performedBy}` : ''}
                  </div>
                  {entry.reason && <div className="mt-1 text-xs text-white/50">{entry.reason}</div>}
                </div>
              ))}
            </div>

            {hasMore && (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={() => void load(entries.length, true)}
                  disabled={loading}
                  className="h-11 rounded-2xl border border-white/20 px-6 text-sm hover:bg-white/5 disabled:opacity-40"
                >
                  {loading ? 'Cargando…' : 'Cargar más'}
                </button>
              </div>
            )}
          </>
        )}

        <p className="mt-4 text-xs text-white/40">
          Solo lectura. El ledger es append-only: los saldos mostrados son los del momento del movimiento.
        </p>
      </div>
    </div>
  );
}

