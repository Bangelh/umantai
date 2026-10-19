'use client';

import { useState } from 'react';
import { withAdminAuth } from '@/lib/adminAuth';
import type { AdminInventoryItem, InventoryStatus } from '@/lib/inventory-admin';

interface Props {
  items: AdminInventoryItem[];
  loading: boolean;
  onChanged: () => Promise<void> | void;
}

const STATUS_META: Record<InventoryStatus, { label: string; className: string }> = {
  available: { label: 'Disponible', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  low: { label: 'Poco stock', className: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  out: { label: 'Agotado', className: 'border-red-500/40 bg-red-500/10 text-red-300' },
};

function StatusBadge({ status }: { status: InventoryStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function ThresholdEditor({
  item,
  onSaved,
  onCancel,
}: {
  item: AdminInventoryItem;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(String(item.reorderPoint));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const reorderPoint = Number(value);
    if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
      setError('El umbral debe ser un entero mayor o igual que 0.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        '/api/admin/inventory',
        withAdminAuth({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productSlug: item.productSlug,
            variantKey: item.variantKey,
            reorderPoint,
          }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? 'No se pudo guardar el umbral.');
        return;
      }
      await onSaved();
    } catch {
      setError('Error de red al guardar el umbral.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
            if (event.key === 'Escape') onCancel();
          }}
          aria-label={`Umbral de stock bajo para ${item.productName}`}
          className="h-9 w-24 rounded-xl border border-white/20 bg-neutral-950 px-2 text-sm"
          autoFocus
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="h-9 rounded-xl bg-white px-3 text-xs font-medium text-black disabled:opacity-50"
        >
          {saving ? '…' : 'Guardar'}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-white/50 hover:text-white">
          Cancelar
        </button>
      </div>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

export function InventoryTable({ items, loading, onChanged }: Props) {
  const [editing, setEditing] = useState<string | null>(null);

  const rowKey = (item: AdminInventoryItem) => `${item.productSlug}:${item.variantKey}`;

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Cargando inventario">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-16 animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-white/15 p-10 text-center">
        <p className="text-lg font-medium">No hay SKUs que coincidan.</p>
        <p className="mt-1 text-sm text-white/50">
          Ajusta la búsqueda o registra una entrada de mercadería para crear stock.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Escritorio */}
      <div className="hidden overflow-hidden rounded-3xl border border-white/15 md:block">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-white/60">
            <tr>
              <th className="px-4 py-3 font-medium">Producto</th>
              <th className="px-4 py-3 font-medium">Variante</th>
              <th className="px-4 py-3 text-right font-medium">Físico</th>
              <th className="px-4 py-3 text-right font-medium">Reservado</th>
              <th className="px-4 py-3 text-right font-medium">Disponible</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium">Umbral</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={rowKey(item)} className="border-t border-white/10 align-top">
                <td className="px-4 py-4">
                  <div className="font-medium">{item.productName}</div>
                  <div className="text-xs text-white/45">
                    {item.productBrand ? `${item.productBrand} · ` : ''}
                    {item.productSlug}
                  </div>
                </td>
                <td className="px-4 py-4 text-white/70">{item.variantKey || '—'}</td>
                <td className="px-4 py-4 text-right font-mono">{item.quantityOnHand}</td>
                <td className="px-4 py-4 text-right font-mono">{item.quantityReserved}</td>
                <td className="px-4 py-4 text-right font-mono">{item.quantityAvailable}</td>
                <td className="px-4 py-4">
                  <StatusBadge status={item.status} />
                </td>
                <td className="px-4 py-4">
                  {editing === rowKey(item) ? (
                    <ThresholdEditor
                      item={item}
                      onSaved={async () => {
                        setEditing(null);
                        await onChanged();
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing(rowKey(item))}
                      className="rounded-full border border-white/20 px-3 py-1 text-xs text-white/70 hover:bg-white/5"
                      aria-label={`Editar umbral de ${item.productName}`}
                    >
                      {item.reorderPoint > 0 ? item.reorderPoint : 'sin alerta'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Móvil */}
      <div className="space-y-3 md:hidden">
        {items.map((item) => (
          <div key={rowKey(item)} className="rounded-2xl border border-white/15 bg-neutral-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{item.productName}</div>
                <div className="text-xs text-white/45">
                  {item.variantKey || 'sin variante'} · {item.productSlug}
                </div>
              </div>
              <StatusBadge status={item.status} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-white/60">
              <div className="rounded-xl bg-neutral-950/60 p-2">
                <dt>Físico</dt>
                <dd className="font-mono text-base text-white">{item.quantityOnHand}</dd>
              </div>
              <div className="rounded-xl bg-neutral-950/60 p-2">
                <dt>Reservado</dt>
                <dd className="font-mono text-base text-white">{item.quantityReserved}</dd>
              </div>
              <div className="rounded-xl bg-neutral-950/60 p-2">
                <dt>Disponible</dt>
                <dd className="font-mono text-base text-white">{item.quantityAvailable}</dd>
              </div>
            </dl>
            <div className="mt-3">
              {editing === rowKey(item) ? (
                <ThresholdEditor
                  item={item}
                  onSaved={async () => {
                    setEditing(null);
                    await onChanged();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(rowKey(item))}
                  className="text-xs text-white/60 underline-offset-2 hover:text-white hover:underline"
                >
                  Umbral de alerta: {item.reorderPoint > 0 ? item.reorderPoint : 'sin alerta'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
