'use client';

import { useMemo, useRef, useState } from 'react';
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
      return 'La cantidad debe ser un entero mayor que 0.';
    }
    if (reason.trim().length < 3) {
      return 'El motivo es obligatorio (mínimo 3 caracteres).';
    }
    if (reason.trim().length > 200) {
      return 'El motivo no puede superar 200 caracteres.';
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
        setFeedback({ type: 'error', message: payload?.error ?? 'No se pudo aplicar el ajuste.' });
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
            ? `Ajuste aplicado: físico ${before.onHand} → ${after.onHand}, reservado ${after.reserved}, disponible ${after.available}.`
            : 'Ajuste aplicado.',
      });
      await onSuccess('Ajuste aplicado');
    } catch {
      setFeedback({ type: 'error', message: 'Error de red al aplicar el ajuste.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={requestConfirmation} className="rounded-3xl border border-white/15 bg-neutral-900 p-6">
      <div className="text-sm uppercase tracking-widest text-white/60">Ajuste de stock</div>
      <p className="mt-1 text-xs text-white/45">
        Motivo obligatorio. El ajuste es atómico y no puede dejar el físico por debajo de lo reservado.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-white/60">Producto</span>
          <select
            value={productSlug}
            onChange={(event) => {
              setProductSlug(event.target.value);
              setVariantKey('');
              setConfirming(false);
            }}
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          >
            {catalogProducts.map((product) => (
              <option key={product.slug} value={product.slug}>
                {product.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-white/60">Variante</span>
          <select
            value={effectiveVariantKey}
            onChange={(event) => {
              setVariantKey(event.target.value);
              setConfirming(false);
            }}
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          >
            {choices.map((choice) => (
              <option key={choice.key || 'base'} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-white/60">Dirección</span>
          <select
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as 'increase' | 'decrease');
              setConfirming(false);
            }}
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          >
            <option value="increase">Aumentar (+)</option>
            <option value="decrease">Disminuir (−)</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-white/60">Cantidad</span>
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
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          />
        </label>

        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-white/60">Motivo (obligatorio)</span>
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
            placeholder="Merma, recuento, corrección de carga…"
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          />
        </label>

        <div className="text-sm sm:col-span-2">
          <span className="mb-1 block text-white/60">Actor</span>
          <div className="flex h-11 items-center rounded-xl border border-white/10 bg-neutral-950/60 px-3 text-white/60">
            {actor || 'admin'} <span className="ml-2 text-xs">(se guarda en el movimiento)</span>
          </div>
        </div>
      </div>

      {confirming && (
        <div className="mt-5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p>
            Vas a <strong>{direction === 'increase' ? 'aumentar' : 'disminuir'}</strong>{' '}
            <strong>{parsedAmount}</strong> unidad(es) de{' '}
            <strong>{catalogProducts.find((product) => product.slug === productSlug)?.name}</strong>
            {effectiveVariantKey ? ` (${effectiveVariantKey})` : ''}.
          </p>
          <p className="mt-1 text-xs text-amber-200/80">Motivo: {reason.trim()}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void applyAdjustment()}
              disabled={submitting}
              className="h-10 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
            >
              {submitting ? 'Aplicando…' : 'Confirmar ajuste'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={submitting}
              className="h-10 rounded-xl border border-white/25 px-4 text-sm disabled:opacity-40"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!confirming && (
          <button
            type="submit"
            className="h-11 rounded-2xl bg-white px-6 font-medium text-black hover:bg-white/90"
          >
            Revisar ajuste
          </button>
        )}
        {feedback && (
          <p
            role={feedback.type === 'error' ? 'alert' : 'status'}
            className={feedback.type === 'error' ? 'text-sm text-red-400' : 'text-sm text-emerald-300'}
          >
            {feedback.message}
          </p>
        )}
      </div>
    </form>
  );
}
