'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/components/i18n/I18nProvider';

export default function MerchantStoreError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    console.error('[merchant] no se pudo cargar el panel', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-5xl items-center px-4 py-12 sm:px-6">
      <div className="surface-card mx-auto w-full max-w-lg p-6 text-center sm:p-8">
        <span
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/10 text-destructive"
        >
          <AlertTriangle className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          {t('merchant.errorTitle')}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-secondary">
          {t('merchant.errorBody')}
        </p>
        <button type="button" onClick={reset} className="btn-primary mt-5">
          {t('merchant.retry')}
        </button>
      </div>
    </main>
  );
}
