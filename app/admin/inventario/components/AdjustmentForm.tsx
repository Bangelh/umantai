'use client';

import { useMemo, useRef, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { catalogProducts, variantChoicesFor } from './catalog-options';

interface Props {
  actor: string;
  onSuccess: (message: string) => Promise<void> | void;
}

interface AdjustmentResponse {
  ok?: boolean;
  before?: { onHand: number; reserved: number; available: number };
  after?: { onHand: number; reserved: number; available: number };
  error?: string;
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `adjustment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function AdjustmentForm({ actor, onSuccess }: Props) {
  const { t } = useI18n();
  const [productSlug, setProductSlug] = useState(catalogProducts[0]?.slug ?? '');
  const [variantKey, setVariantKey] = useState('');
  const [direction, setDirection] = useState<'increase' | 'decrease'>('increase');
  const [amount, setAmount] = useState('1');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const idempotencyKeyRef = useRef<string | null>(null);

  const choices = useMemo(() => variantChoicesFor(productSlug), [productSlug]);
  const effectiveVariantKey = choices.some((choice) => choice.key === variantKey)
    ? variantKey
    : (choices[0]?.key ?? '');
  const parsedAmount = Number(amount);
  const delta = direction === 'increase' ? parsedAmount : -parsedAmount;

  const validate = (): string | null => {
    if (!Number.isInteger(parsedAmount) || parsedAmount < 1) {
      return t('inventory.quantityInvalid');
    }
    if (reason.trim().length < 3) {
      return t('inventory.reasonMin');
    }
    if (reason.trim().length > 200) {
      return t('inventory.reasonTooLong');
    }
    return null;
  };

  const requestConfirmation = (event: React.FormEvent) => {
    event.preventDefault();
    const error = validate();
    if (error) {
      setFeedback({ type: 'error', message: error });
      return;
    }
    setFeedback(null);
    setConfirming(true);
  };

  const applyAdjustment = async () => {
    if (!confirming || submitting) return;
    const idempotencyKey =
      idempotencyKeyRef.current ?? (idempotencyKeyRef.current = newKey());

    setSubmitting(true);
    try {
      const response = await fetch(
        '/api/admin/inventory/adjustments',
        withAdminAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productSlug,
            variantKey: effectiveVariantKey,
            delta,
            reason: reason.trim(),
            actor: actor.trim() || 'admin',
            idempotencyKey,
          }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as AdjustmentResponse | null;

      if (!response.ok || !payload?.ok) {
        setFeedback({ type: 'error', message: payload?.error ?? t('inventory.adjustmentFailed') });
        return;
      }

      idempotencyKeyRef.current = null;
      setConfirming(false);
      setAmount('1');
      setReason('');
      const before = payload.before;
      const after = payload.after;
      setFeedback({
        type: 'success',
        message:
          before && after
            ? t('inventory.adjustmentSummary', {
                before: before.onHand,
                after: after.onHand,
                reserved: after.reserved,
                available: after.available,
              })
            : t('inventory.adjustmentApplied'),
      });
      await onSuccess(t('inventory.adjustmentApplied'));
    } catch {
      setFeedback({ type: 'error', message: t('inventory.adjustmentNetworkError') });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={requestConfirmation} className="rounded-3xl border border-border bg-surface p-6">
      <div className="text-sm uppercase tracking-widest text-tertiary">
        {t('inventory.adjustmentTitle')}
      </div>
      <p className="mt-1 text-xs text-muted">{t('inventory.adjustmentSubtitle')}</p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-tertiary">{t('inventory.product')}</span>
          <select
            value={productSlug}
            onChange={(event) => {
              setProductSlug(event.target.value);
              setVariantKey('');
              setConfirming(false);
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
            onChange={(event) => {
              setVariantKey(event.target.value);
              setConfirming(false);
            }}
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
          <span className="mb-1 block text-tertiary">{t('inventory.direction')}</span>
          <select
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as 'increase' | 'decrease');
              setConfirming(false);
            }}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          >
            <option value="increase">{t('inventory.increase')}</option>
            <option value="decrease">{t('inventory.decrease')}</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-tertiary">{t('inventory.quantity')}</span>
          <input
            type="number"
            min={1}
            step={1}
            required
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setConfirming(false);
            }}
            className="h-11 w-full rounded-xl border border-border-strong bg-background px-3"
          />
        </label>

        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-tertiary">{t('inventory.reasonRequired')}</span>
          <input
            type="text"
            required
            minLength={3}
            maxLength={200}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setConfirming(false);
            }}
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

      {confirming && (
        <div className="mt-5 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          <p>
            {t('inventory.adjustmentWill', {
              direction:
                direction === 'increase'
                  ? t('inventory.increaseVerb')
                  : t('inventory.decreaseVerb'),
              amount: parsedAmount,
              product: `${
                catalogProducts.find((product) => product.slug === productSlug)?.name ?? ''
              }${effectiveVariantKey ? ` (${effectiveVariantKey})` : ''}`,
            })}
          </p>
          <p className="mt-1 text-xs text-warning/80">
            {t('inventory.adjustmentReason', { reason: reason.trim() })}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void applyAdjustment()}
              disabled={submitting}
              className="h-10 rounded-xl bg-brand px-4 text-sm font-medium text-background disabled:opacity-50"
            >
              {submitting ? t('inventory.adjustmentApplying') : t('inventory.adjustmentConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={submitting}
              className="h-10 rounded-xl border border-border-strong px-4 text-sm disabled:opacity-40"
            >
              {t('inventory.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!confirming && (
          <button
            type="submit"
            className="h-11 rounded-2xl bg-brand px-6 font-medium text-background hover:opacity-90"
          >
            {t('inventory.adjustmentReview')}
          </button>
        )}
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
