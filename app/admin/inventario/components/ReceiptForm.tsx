'use client';

import { useMemo, useRef, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { catalogProducts, variantChoicesFor } from './catalog-options';

interface Props {
  actor: string;
  onSuccess: (message: string) => Promise<void> | void;
}

interface ReceiptResponse {
  ok?: boolean;
  item?: { quantityOnHand: number; quantityAvailable: number };
  thresholdWarning?: string | null;
  error?: string;
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `receipt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ReceiptForm({ actor, onSuccess }: Props) {
  const { t } = useI18n();
  const [productSlug, setProductSlug] = useState(catalogProducts[0]?.slug ?? '');
  const [variantKey, setVariantKey] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [reorderPoint, setReorderPoint] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const idempotencyKeyRef = useRef<string | null>(null);

  const choices = useMemo(() => variantChoicesFor(productSlug), [productSlug]);
  const effectiveVariantKey = choices.some((choice) => choice.key === variantKey)
    ? variantKey
    : (choices[0]?.key ?? '');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      setFeedback({ type: 'error', message: t('inventory.quantityInvalid') });
      return;
    }

    let parsedReorderPoint: number | undefined;
    if (reorderPoint.trim() !== '') {
      parsedReorderPoint = Number(reorderPoint);
      if (!Number.isInteger(parsedReorderPoint) || parsedReorderPoint < 0) {
        setFeedback({ type: 'error', message: t('inventory.thresholdInvalid') });
        return;
      }
    }

    if (reason.trim().length > 200) {
      setFeedback({ type: 'error', message: t('inventory.referenceTooLong') });
      return;
    }

    const idempotencyKey =
      idempotencyKeyRef.current ?? (idempotencyKeyRef.current = newKey());

    setSubmitting(true);
    setFeedback(null);
    try {
      const response = await fetch(
        '/api/admin/inventory/receipts',
        withAdminAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productSlug,
            variantKey: effectiveVariantKey,
            quantity: parsedQuantity,
            reason: reason.trim() || undefined,
            actor: actor.trim() || 'admin',
            reorderPoint: parsedReorderPoint,
            idempotencyKey,
          }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as ReceiptResponse | null;

      if (!response.ok || !payload?.ok) {
        setFeedback({ type: 'error', message: payload?.error ?? t('inventory.receiptFailed') });
        return;
      }

      idempotencyKeyRef.current = null;
      const item = payload.item;
      const detail = item
        ? ` ${t('inventory.receiptDetail', {
            onHand: item.quantityOnHand,
            available: item.quantityAvailable,
          })}`
        : '';
      const warning = payload.thresholdWarning ? ` ${payload.thresholdWarning}` : '';
      setFeedback({
        type: 'success',
        message: `${t('inventory.receiptRegistered')}.${detail}${warning}`,
      });
      setQuantity('1');
      setReason('');
      await onSuccess(t('inventory.receiptRegistered'));
    } catch {
      setFeedback({ type: 'error', message: t('inventory.receiptNetworkError') });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-3xl border border-border bg-surface p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm uppercase tracking-widest text-tertiary">
            {t('inventory.receiptTitle')}
          </div>
          <p className="mt-1 text-xs text-muted">{t('inventory.receiptSubtitle')}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-tertiary">{t('inventory.product')}</span>
          <select
            value={productSlug}
            onChange={(event) => {
              setProductSlug(event.target.value);
              setVariantKey('');
            }}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          >
            {catalogProducts.map((product) => (
              <option key={product.slug} value={product.slug}>
                {product.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-tertiary">{t('inventory.variant')}</span>
          <select
            value={effectiveVariantKey}
            onChange={(event) => setVariantKey(event.target.value)}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          >
            {choices.map((choice) => (
              <option key={choice.key || 'base'} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-tertiary">{t('inventory.quantity')}</span>
          <input
            type="number"
            min={1}
            step={1}
            required
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-tertiary">{t('inventory.reorderOptional')}</span>
          <input
            type="number"
            min={0}
            step={1}
            value={reorderPoint}
            onChange={(event) => setReorderPoint(event.target.value)}
            placeholder={t('inventory.reorderPlaceholder')}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          />
        </label>

        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-tertiary">{t('inventory.reasonOptional')}</span>
          <input
            type="text"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('inventory.reasonPlaceholder')}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          />
        </label>

        <div className="text-sm sm:col-span-2">
          <span className="mb-1 block text-tertiary">{t('inventory.actor')}</span>
          <div className="flex h-11 items-center rounded-xl border border-border bg-surface-raised px-3 text-tertiary">
            {actor || 'admin'}{' '}
            <span className="ml-2 text-xs">{t('inventory.actorNote')}</span>
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="h-11 rounded-2xl bg-brand px-6 font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? t('inventory.registering') : t('inventory.registerReceipt')}
        </button>
        {feedback && (
          <p
            role={feedback.type === 'error' ? 'alert' : 'status'}
            className={feedback.type === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}
          >
            {feedback.message}
          </p>
        )}
      </div>
    </form>
  );
}
