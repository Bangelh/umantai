'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Sube el logo de LA tienda. El archivo lo guarda `/api/merchant/stores/:id/media`
 * con `scope=store_logo`; el servidor valida membresía y formato antes de
 * escribir. Aquí solo se elige el archivo y se refresca la página.
 */
export function StoreLogoButton({
  storeId,
  hasLogo,
}: {
  storeId: string;
  hasLogo: boolean;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('scope', 'store_logo');
      const response = await fetch(`/api/merchant/stores/${storeId}/media`, {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.uploadLogoFailed'));
      toast.success(t('merchant.logoUpdated'));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.uploadLogoFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="inline-flex h-9 items-center rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-raised disabled:opacity-50"
      >
        {hasLogo ? t('merchant.changeLogo') : t('merchant.addLogo')}
      </button>
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
    </>
  );
}
