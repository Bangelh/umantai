'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * WhatsApp de la tienda.
 *
 * Es el canal por el que el comprador avisa su pedido y manda la captura del
 * pago, así que el número tiene que ser el del negocio, no el de UMANTAI.
 * Se guarda en `stores.contact_phone`; el servidor normaliza a +51.
 */
export function StoreWhatsAppForm({
  storeId,
  initialPhone,
}: {
  storeId: string;
  initialPhone: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [phone, setPhone] = useState(initialPhone?.replace(/^51/, '') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactPhone: phone.trim() || null }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t('merchant.whatsappInvalid'));
      }
      toast.success(t('merchant.whatsappSaved'));
      router.refresh();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : t('merchant.whatsappInvalid'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <label htmlFor="store-whatsapp" className="field-label">
          {t('merchant.whatsappLabel')}
        </label>
        <div className="flex h-11 items-center rounded-xl border border-border-strong bg-background transition-colors focus-within:border-primary">
          <span className="pl-3 font-mono text-sm text-tertiary">+51</span>
          <input
            id="store-whatsapp"
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder={t('merchant.whatsappPlaceholder')}
            maxLength={15}
            autoComplete="tel-national"
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-body text-primary outline-none placeholder:text-muted"
          />
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn-primary w-full text-sm sm:w-auto">
        {busy ? t('merchant.whatsappSaving') : t('merchant.whatsappSave')}
      </button>
    </form>
  );
}
