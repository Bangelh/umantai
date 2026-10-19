'use client';

import { useMemo, useRef, useState } from 'react';
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
      setFeedback({ type: 'error', message: 'La cantidad debe ser un entero mayor que 0.' });
      return;
    }

    let parsedReorderPoint: number | undefined;
    if (reorderPoint.trim() !== '') {
      parsedReorderPoint = Number(reorderPoint);
      if (!Number.isInteger(parsedReorderPoint) || parsedReorderPoint < 0) {
        setFeedback({ type: 'error', message: 'El umbral debe ser un entero mayor o igual que 0.' });
        return;
      }
    }

    if (reason.trim().length > 200) {
      setFeedback({ type: 'error', message: 'La referencia no puede superar 200 caracteres.' });
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
        setFeedback({ type: 'error', message: payload?.error ?? 'No se pudo registrar el ingreso.' });
        return;
      }

      idempotencyKeyRef.current = null;
      const item = payload.item;
      const detail = item
        ? ` Físico: ${item.quantityOnHand} · disponible: ${item.quantityAvailable}.`
        : '';
      const warning = payload.thresholdWarning ? ` ${payload.thresholdWarning}` : '';
      setFeedback({ type: 'success', message: `Ingreso registrado.${detail}${warning}` });
      setQuantity('1');
      setReason('');
      await onSuccess('Ingreso registrado');
    } catch {
      setFeedback({ type: 'error', message: 'Error de red al registrar el ingreso.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-3xl border border-white/15 bg-neutral-900 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm uppercase tracking-widest text-white/60">Entrada de mercadería</div>
          <p className="mt-1 text-xs text-white/45">
            Genera un movimiento <span className="font-mono">receipt</span> en el ledger.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-white/60">Producto</span>
          <select
            value={productSlug}
            onChange={(event) => {
              setProductSlug(event.target.value);
              setVariantKey('');
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
            onChange={(event) => setVariantKey(event.target.value)}
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
          <span className="mb-1 block text-white/60">Cantidad</span>
          <input
            type="number"
            min={1}
            step={1}
            required
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-white/60">Umbral de stock bajo (opcional)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={reorderPoint}
            onChange={(event) => setReorderPoint(event.target.value)}
            placeholder="ej. 5"
            className="h-11 w-full rounded-xl border border-white/20 bg-neutral-950 px-3"
          />
        </label>

        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-white/60">Motivo / referencia (opcional)</span>
          <input
            type="text"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Factura, proveedor, guía…"
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

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="h-11 rounded-2xl bg-white px-6 font-medium text-black hover:bg-white/90 disabled:bg-white/50"
        >
          {submitting ? 'Registrando…' : 'Registrar ingreso'}
        </button>
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
