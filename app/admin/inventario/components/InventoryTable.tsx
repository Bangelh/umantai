'use client';

import { useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import type { AdminInventoryItem, InventoryStatus } from '@/lib/inventory-admin';

interface Props {
  items: AdminInventoryItem[];
  loading: boolean;
  onChanged: () => Promise<void> | void;
}

const STATUS_META: Record<
  InventoryStatus,
  { labelKey: 'inventory.available' | 'inventory.low' | 'inventory.out'; className: string }
> = {
  available: { labelKey: 'inventory.available', className: 'border-success/40 bg-success/10 text-success' },
  low: { labelKey: 'inventory.low', className: 'border-warning/40 bg-warning/10 text-warning' },
  out: { labelKey: 'inventory.out', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
};

function StatusBadge({ status }: { status: InventoryStatus }) {
  const { t } = useI18n();
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${meta.className}`}>
      {t(meta.labelKey)}
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
  const { t } = useI18n();
  const [value, setValue] = useState(String(item.reorderPoint));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const reorderPoint = Number(value);
    if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
      setError(t('inventory.thresholdInvalid'));
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
        setError(payload?.error ?? t('inventory.thresholdSaveFailed'));
        return;
      }
      await onSaved();
    } catch {
      setError(t('inventory.thresholdNetworkError'));
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
          aria-label={t('inventory.thresholdAria', { product: item.productName })}
          className="h-9 w-24 rounded-xl border border-border-strong bg-background px-2 text-sm"
          autoFocus
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="h-9 rounded-xl bg-brand px-3 text-xs font-medium text-background disabled:opacity-50"
        >
          {saving ? '…' : t('inventory.save')}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-tertiary hover:text-primary">
          {t('inventory.cancel')}
        </button>
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

export function InventoryTable({ items, loading, onChanged }: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);

  const rowKey = (item: AdminInventoryItem) => `${item.productSlug}:${item.variantKey}`;

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('inventory.loading')}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-16 animate-pulse rounded-2xl bg-surface-raised" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border p-10 text-center">
        <p className="text-lg font-medium">{t('inventory.noMatches')}</p>
        <p className="mt-1 text-sm text-tertiary">{t('inventory.noMatchesBody')}</p>
      </div>
    );
  }

  return (
    <>
      {/* Escritorio */}
      <div className="hidden overflow-hidden rounded-3xl border border-border md:block">
        <table className="w-full text-sm">
          <thead className="bg-surface-raised text-left text-tertiary">
            <tr>
              <th className="px-4 py-3 font-medium">{t('inventory.product')}</th>
              <th className="px-4 py-3 font-medium">{t('inventory.variant')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('inventory.onHand')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('inventory.reserved')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('inventory.available')}</th>
              <th className="px-4 py-3 font-medium">{t('inventory.status')}</th>
              <th className="px-4 py-3 font-medium">{t('inventory.threshold')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={rowKey(item)} className="border-t border-border align-top">
                <td className="px-4 py-4">
                  <div className="font-medium">{item.productName}</div>
                  <div className="text-xs text-muted">
                    {item.productBrand ? `${item.productBrand} · ` : ''}
                    {item.productSlug}
                  </div>
                </td>
                <td className="px-4 py-4 text-secondary">{item.variantKey || '—'}</td>
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
                      className="rounded-full border border-border-strong px-3 py-1 text-xs text-secondary hover:bg-surface-raised"
                      aria-label={t('inventory.editThreshold', { product: item.productName })}
                    >
                      {item.reorderPoint > 0 ? item.reorderPoint : t('inventory.noAlert')}
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
          <div key={rowKey(item)} className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{item.productName}</div>
                <div className="text-xs text-muted">
                  {item.variantKey || t('inventory.noVariant')} · {item.productSlug}
                </div>
              </div>
              <StatusBadge status={item.status} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-tertiary">
              <div className="rounded-xl bg-background p-2">
                <dt>{t('inventory.onHand')}</dt>
                <dd className="font-mono text-base text-primary">{item.quantityOnHand}</dd>
              </div>
              <div className="rounded-xl bg-background p-2">
                <dt>{t('inventory.reserved')}</dt>
                <dd className="font-mono text-base text-primary">{item.quantityReserved}</dd>
              </div>
              <div className="rounded-xl bg-background p-2">
                <dt>{t('inventory.available')}</dt>
                <dd className="font-mono text-base text-primary">{item.quantityAvailable}</dd>
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
                  className="text-xs text-tertiary underline-offset-2 hover:text-primary hover:underline"
                >
                  {t('inventory.thresholdAlert', {
                    value: item.reorderPoint > 0 ? item.reorderPoint : t('inventory.noAlert'),
                  })}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
