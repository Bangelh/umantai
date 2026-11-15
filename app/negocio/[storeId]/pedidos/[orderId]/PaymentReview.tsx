'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Revisión del comprobante por parte de la tienda.
 *
 * "Confirmar pago" llama al mismo motor que confirmaba la pasarela
 * (`confirm_order_payment`): re-reserva si la reserva se liberó y deja el pedido
 * `confirmed` con el stock comprometido. No hay un segundo camino de
 * confirmación que pueda desincronizar el inventario.
 *
 * "Rechazar" solo marca el comprobante; el pedido sigue pendiente hasta que
 * venza su reserva, así el comprador puede subir otra captura.
 */
export function PaymentReview({
  storeId,
  orderId,
  hasProof,
}: {
  storeId: string;
  orderId: string;
  hasProof: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = async (action: 'approve' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/merchant/stores/${storeId}/orders/${orderId}/payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            note: note.trim() ? note.trim() : undefined,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t('merchant.proofActionFailed'));
      }
      toast.success(
        action === 'approve'
          ? t('merchant.proofApproved')
          : t('merchant.proofRejectedToast'),
      );
      router.refresh();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : t('merchant.proofActionFailed'),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3">
      <label htmlFor="payment-review-note" className="block text-xs text-tertiary">
        {t('merchant.proofNoteLabel')}
      </label>
      <input
        id="payment-review-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={280}
        placeholder={t('merchant.proofNotePlaceholder')}
        className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm"
      />

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void send('approve')}
          disabled={busy !== null || !hasProof}
          className="min-h-12 flex-1 rounded-xl bg-brand px-4 text-body font-semibold text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'approve' ? t('merchant.proofApproving') : t('merchant.proofApprove')}
        </button>
        <button
          type="button"
          onClick={() => void send('reject')}
          disabled={busy !== null || !hasProof}
          className="min-h-12 rounded-xl border border-border-strong px-4 text-body font-medium hover:bg-surface-raised disabled:opacity-40"
        >
          {busy === 'reject' ? t('merchant.proofRejecting') : t('merchant.proofReject')}
        </button>
      </div>

      <p className="mt-2 text-xs text-tertiary">{t('merchant.proofRejectHint')}</p>

      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
