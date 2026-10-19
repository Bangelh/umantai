'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { getAdminToken, setAdminToken, withAdminAuth } from '@/lib/adminAuth';
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
  const [token, setToken] = useState('');
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authChecking, setAuthChecking] = useState(false);

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
        setError(payload?.error ?? 'No se pudo cargar el inventario.');
        return;
      }
      applyPayload(payload);
    } catch {
      setError('Error de red al cargar el inventario.');
    } finally {
      setLoading(false);
    }
  }, [applyPayload]);

  const handleLogin = async () => {
    const candidate = token.trim();
    if (!candidate) return;
    setAuthError(null);
    setAuthChecking(true);
    try {
      const response = await fetch('/api/admin/inventory', withAdminAuth({}, candidate));
      const payload = (await response.json().catch(() => null)) as InventoryPayload | null;
      if (!response.ok || !payload?.ok) {
        setAuthError(payload?.error ?? 'Token de administración inválido.');
        return;
      }
      setAdminToken(candidate);
      applyPayload(payload);
      setAuthed(true);
    } catch {
      setAuthError('No hay conexión con el servidor.');
    } finally {
      setAuthChecking(false);
    }
  };

  // Reutiliza el token guardado si sigue siendo válido.
  useEffect(() => {
    const stored = getAdminToken();
    if (!stored) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/admin/inventory', withAdminAuth({}, stored));
        const payload = (await response.json().catch(() => null)) as InventoryPayload | null;
        if (!cancelled && response.ok && payload?.ok) {
          applyPayload(payload);
          setAuthed(true);
        }
      } catch {
        /* sin conexión: se muestra el login */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyPayload]);

  const summary = useMemo(() => summarizeInventory(items), [items]);
  const filtered = useMemo(() => filterInventoryItems(items, filters), [items, filters]);

  const onChanged = useCallback(
    async (message: string) => {
      toast.success(message);
      await load();
    },
    [load],
  );

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-8 text-white">
        <div className="w-full max-w-sm rounded-3xl border border-white/15 bg-neutral-900 p-8">
          <h1 className="mb-2 text-2xl font-semibold">Inventario</h1>
          <p className="mb-6 text-sm text-white/60">Ingresa el token de administración.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleLogin();
            }}
          >
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="ADMIN_API_SECRET"
              aria-label="Token de administración"
              className="mb-4 h-12 w-full rounded-2xl border border-white/20 bg-neutral-950 px-4"
              autoFocus
            />
            {authError && <p className="mb-4 text-sm text-red-400">{authError}</p>}
            <button
              type="submit"
              disabled={authChecking}
              className="h-12 w-full rounded-2xl bg-white font-medium text-black hover:bg-white/90 disabled:bg-white/50"
            >
              {authChecking ? 'Verificando…' : 'Entrar'}
            </button>
          </form>
          <Link href="/admin" className="mt-4 block text-center text-xs text-white/50 hover:text-white">
            ← Volver al panel
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 p-4 text-white sm:p-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[3px] text-white/50">OPERACIÓN</div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Inventario</h1>
            <p className="mt-1 text-sm text-white/50">
              Stock real, ledger y alertas. El inventario es la única autoridad.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-white/50">
              <span className="mr-2">Actor</span>
              <input
                value={actor}
                onChange={(event) => rememberActor(event.target.value)}
                maxLength={80}
                aria-label="Actor de los movimientos"
                className="h-9 w-40 rounded-xl border border-white/20 bg-neutral-900 px-3 text-sm text-white"
              />
            </label>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/5"
            >
              {loading ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>
        </div>

        <div className="mt-4">
          <AdminNav />
        </div>

        <div className="mt-6 flex gap-2 border-b border-white/10" role="tablist" aria-label="Secciones de inventario">
          {(['inventario', 'movimientos'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`-mb-px border-b-2 px-4 py-3 text-sm capitalize ${
                tab === value
                  ? 'border-white text-white'
                  : 'border-transparent text-white/50 hover:text-white/80'
              }`}
            >
              {value === 'inventario' ? 'Inventario y entradas' : 'Historial de movimientos'}
            </button>
          ))}
        </div>

        {error && (
          <div role="alert" className="mt-6 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-200">
            {error}
          </div>
        )}

        {tab === 'inventario' ? (
          <div className="mt-6 space-y-6">
            <section aria-label="Resumen de inventario" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <SummaryCard label="SKUs" value={summary.skuCount} />
              <SummaryCard label="Físico" value={summary.unitsOnHand} />
              <SummaryCard label="Reservado" value={summary.unitsReserved} />
              <SummaryCard label="Poco stock" value={summary.lowCount} tone="amber" />
              <SummaryCard label="Agotados" value={summary.outCount} tone="red" />
            </section>

            {lowStock.length > 0 && (
              <div className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-5">
                <div className="text-xs uppercase tracking-widest text-amber-300">
                  ⚠ {lowStock.length} SKU(s) requieren reposición
                </div>
                <ul className="mt-3 grid gap-1 text-sm text-amber-100 sm:grid-cols-2">
                  {lowStock.slice(0, 8).map((item) => (
                    <li key={`${item.productSlug}:${item.variantKey}`}>
                      {item.productName}
                      {item.variantKey ? ` (${item.variantKey})` : ''}:{' '}
                      <span className="font-mono">{item.quantityAvailable}</span> disponibles
                    </li>
                  ))}
                </ul>
                {lowStock.length > 8 && (
                  <p className="mt-2 text-xs text-amber-200/70">y {lowStock.length - 8} más…</p>
                )}
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              <ReceiptForm actor={actor} onSuccess={onChanged} />
              <AdjustmentForm actor={actor} onSuccess={onChanged} />
            </div>

            <section aria-label="Listado de inventario">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-lg font-medium">Stock por SKU</h2>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="search"
                    value={filters.q}
                    onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
                    placeholder="Buscar producto, marca o SKU…"
                    aria-label="Buscar inventario"
                    className="h-10 w-full rounded-xl border border-white/20 bg-neutral-900 px-3 text-sm sm:w-72"
                  />
                  <select
                    value={filters.status}
                    onChange={(event) =>
                      setFilters((current) => ({
                        ...current,
                        status: event.target.value as InventoryStatus | 'all',
                      }))
                    }
                    aria-label="Filtrar por estado"
                    className="h-10 rounded-xl border border-white/20 bg-neutral-900 px-3 text-sm"
                  >
                    <option value="all">Todos los estados</option>
                    <option value="available">Disponible</option>
                    <option value="low">Poco stock</option>
                    <option value="out">Agotado</option>
                  </select>
                </div>
              </div>

              <p className="mt-2 text-xs text-white/40">
                Mostrando {filtered.length} de {items.length} SKUs. Stock bajo = disponible ≤ umbral
                del SKU.
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
    tone === 'amber' ? 'text-amber-300' : tone === 'red' ? 'text-red-300' : 'text-white';

  return (
    <div className="rounded-2xl border border-white/15 bg-neutral-900 p-4">
      <div className="text-xs uppercase tracking-widest text-white/45">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${valueClass}`}>{value}</div>
    </div>
  );
}
