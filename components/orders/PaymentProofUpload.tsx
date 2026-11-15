'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Subida de la captura del pago.
 *
 * El comprador paga por Yape/Plin directo a la tienda y adjunta la captura. El
 * archivo va a `/api/orders/<token>/proof`, que valida que el pedido siga
 * pendiente y con reserva viva; la tienda después lo revisa y confirma el pago.
 *
 * No hay pasarela de por medio: el comprobante es la prueba y la tienda decide.
 */
export function PaymentProofUpload({
  publicToken,
  status,
}: {
  publicToken: string;
  status: 'submitted' | 'approved' | 'rejected' | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      setError(t('order.proofTooLarge'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await fetch(`/api/orders/${publicToken}/proof`, {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t('order.proofFailed'));
      }
      setUploaded(true);
      toast.success(t('order.proofUploaded'));
      router.refresh();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : t('order.proofFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (status === 'submitted' || uploaded) {
    return (
      <p
        role="status"
        className="mt-4 rounded-xl border border-info/40 bg-info/10 px-4 py-3 text-body text-info"
      >
        {t('order.proofPending')}
      </p>
    );
  }

  return (
    <div className="mt-4">
      {status === 'rejected' && (
        <p className="mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive">
          {t('order.proofRejected')}
        </p>
      )}

      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="inline-flex min-h-12 items-center rounded-xl border border-border-strong px-5 text-body font-medium hover:bg-surface-raised disabled:opacity-50"
      >
        {busy ? t('order.proofUploading') : t('order.proofChoose')}
      </button>
      <p className="mt-2 text-sm text-tertiary">{t('order.proofBody')}</p>

      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
