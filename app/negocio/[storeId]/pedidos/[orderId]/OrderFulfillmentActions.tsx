'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Acciones de preparación y entrega desde el panel del comerciante.
 *
 * - `confirmed` / `preparing`: "Marcar listo para recoger" emite el PIN y avisa
 *   al comprador.
 * - `ready_for_pickup`: se ingresa el PIN que dicta el cliente; el canje
 *   consolida el stock y deja el pedido entregado.
 */
export function OrderFulfillmentActions({
  storeId,
  orderId,
  status,
}: {
  storeId: string;
  orderId: string;
  status: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const markReady = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/merchant/stores/${storeId}/orders/${orderId}/ready`,
        { method: 'POST' },
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; customerNotification?: string }
        | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.actionFailed'));

      toast.success(t('merchant.markedReady'));
      if (payload?.customerNotification === 'sent') {
        toast.success(t('merchant.buyerNotified'));
      } else {
        toast.message(t('merchant.buyerNotNotified'));
      }
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('merchant.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const redeem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/merchant/stores/${storeId}/orders/${orderId}/pickup`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code.trim() }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; orderNumber?: string }
        | null;
      if (!response.ok || payload?.error) {
        throw new Error(payload?.error ?? t('merchant.pickupFailed'));
      }
      toast.success(t('merchant.pickupDone', { number: payload?.orderNumber ?? '' }));
      setCode('');
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('merchant.pickupFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (status === 'confirmed' || status === 'preparing') {
    return (
      <section className="mt-5 rounded-2xl border border-brand/40 bg-brand/5 p-4">
        <h2 className="text-sm font-semibold">{t('merchant.readyTitle')}</h2>
        <p className="mt-1 text-sm text-secondary">{t('merchant.readyBody')}</p>
        <button
          type="button"
          onClick={() => void markReady()}
          disabled={busy}
          className="mt-3 h-12 w-full rounded-xl bg-brand px-5 text-base font-semibold text-background disabled:opacity-40 sm:w-auto"
        >
          {busy ? t('merchant.markingReady') : t('merchant.markReady')}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (status === 'ready_for_pickup') {
    return (
      <section className="mt-5 rounded-2xl border border-success/40 bg-success/10 p-4">
        <h2 className="text-sm font-semibold text-success">{t('merchant.pickupTitle')}</h2>
        <p className="mt-1 text-sm text-secondary">{t('merchant.pickupBody')}</p>
        <form onSubmit={redeem} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            aria-label={t('merchant.pickupCodeLabel')}
            className="h-14 w-full rounded-xl border border-border-strong bg-background text-center font-mono text-2xl tracking-[0.4em] sm:max-w-56"
          />
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="h-14 rounded-xl bg-brand px-6 text-base font-semibold text-background disabled:opacity-40"
          >
            {busy ? t('merchant.pickupChecking') : t('merchant.pickupConfirm')}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }

  return null;
}
