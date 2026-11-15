'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Datos de pago que ve el comprador después de confirmar el pedido.
 *
 * Antes la página solo decía "paga por Yape o Plin a la tienda" sin números:
 * el comprador no tenía a dónde transferir. La tienda los carga acá y el
 * checkout/la página del pedido los muestran. El efectivo es opt-in y solo se
 * habilita para compradores con cuenta.
 */
export function StorePaymentsForm({
  storeId,
  initial,
}: {
  storeId: string;
  initial: {
    yape: string | null;
    plin: string | null;
    bankAccount: string | null;
    holder: string | null;
    cash: boolean;
  };
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [yape, setYape] = useState(initial.yape ?? '');
  const [plin, setPlin] = useState(initial.plin ?? '');
  const [bankAccount, setBankAccount] = useState(initial.bankAccount ?? '');
  const [holder, setHolder] = useState(initial.holder ?? '');
  const [cash, setCash] = useState(initial.cash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payments: {
            yape: yape.trim() || null,
            plin: plin.trim() || null,
            bankAccount: bankAccount.trim() || null,
            holder: holder.trim() || null,
            cash,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t('merchant.paymentsInvalid'));
      }
      toast.success(t('merchant.paymentsSaved'));
      router.refresh();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : t('merchant.paymentsInvalid'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="block">
        <span className="field-label">{t('merchant.paymentsYape')}</span>
        <input
          value={yape}
          onChange={(event) => setYape(event.target.value)}
          inputMode="tel"
          maxLength={20}
          placeholder="987 654 321"
          className="field-input h-11 text-body"
        />
      </label>

      <label className="block">
        <span className="field-label">{t('merchant.paymentsPlin')}</span>
        <input
          value={plin}
          onChange={(event) => setPlin(event.target.value)}
          inputMode="tel"
          maxLength={20}
          placeholder="987 654 321"
          className="field-input h-11 text-body"
        />
      </label>

      <label className="block">
        <span className="field-label">{t('merchant.paymentsBank')}</span>
        <input
          value={bankAccount}
          onChange={(event) => setBankAccount(event.target.value)}
          maxLength={60}
          placeholder="BCP · 193-1234567-0-12"
          className="field-input h-11 text-body"
        />
      </label>

      <label className="block">
        <span className="field-label">{t('merchant.paymentsHolder')}</span>
        <input
          value={holder}
          onChange={(event) => setHolder(event.target.value)}
          maxLength={80}
          placeholder={t('merchant.paymentsHolderPlaceholder')}
          className="field-input h-11 text-body"
        />
      </label>

      <label className="flex items-start gap-3 rounded-xl border border-border bg-background p-3 sm:col-span-2">
        <input
          type="checkbox"
          checked={cash}
          onChange={(event) => setCash(event.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--um-brand)]"
        />
        <span>
          <span className="block text-body font-medium text-primary">
            {t('merchant.paymentsCash')}
          </span>
          <span className="mt-0.5 block text-sm leading-relaxed text-tertiary">
            {t('merchant.paymentsCashHint')}
          </span>
        </span>
      </label>

      <div className="sm:col-span-2">
        <button type="submit" disabled={busy} className="btn-primary w-full text-sm sm:w-auto">
          {busy ? t('merchant.paymentsSaving') : t('merchant.paymentsSave')}
        </button>
        {error && (
          <p
            role="alert"
            className="mt-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
