'use client';

/**
 * components/admin/AdminAccessScreen.tsx — puerta de los paneles /admin.
 *
 * No hay campo de token: el administrador humano usa su cuenta. Si ya inició
 * sesión, el botón canjea esa sesión por la cookie de Platform Admin. Si no,
 * se lo manda a /ingresar y vuelve al mismo panel.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { useI18n } from '@/components/i18n/I18nProvider';
import type { PlatformAdminStatus } from '@/lib/usePlatformAdminSession';

interface Props {
  title: string;
  status: PlatformAdminStatus;
  onActivate: () => Promise<PlatformAdminStatus>;
  /** Texto opcional debajo del título (no se traduce: nombre del panel). */
  subtitle?: string;
}

export function AdminAccessScreen({ title, status, onActivate, subtitle }: Props) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlatformAdminStatus | null>(null);

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await onActivate();
      setResult(next);
    } finally {
      setBusy(false);
    }
  };

  const effective = result ?? status;
  const next = encodeURIComponent(pathname || '/admin');

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-2xl border border-border bg-surface p-6">
        <p className="text-xs uppercase tracking-[2px] text-muted">Platform Admin</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-tertiary">{subtitle}</p>}

        {effective === 'checking' && (
          <p role="status" className="mt-4 text-sm text-tertiary">
            {t('admin.sessionChecking')}
          </p>
        )}

        {effective === 'unavailable' && (
          <p role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {t('common.error')}
          </p>
        )}

        {effective === 'forbidden' && (
          <p role="alert" className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            {t('admin.notAuthorized')}
          </p>
        )}

        {(effective === 'anonymous' || effective === 'forbidden') && (
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={() => void activate()}
              disabled={busy}
              className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50"
            >
              {busy ? t('common.loading') : t('admin.activate')}
            </button>
            <Link
              href={`/ingresar?next=${next}`}
              className="flex h-11 w-full items-center justify-center rounded-xl border border-border-strong text-sm font-medium hover:bg-surface-raised"
            >
              {t('admin.signInWithAccount')}
            </Link>
            <p className="pt-1 text-center text-[11px] text-muted">{t('admin.sessionRequired')}</p>
          </div>
        )}

        <Link href="/admin" className="mt-5 inline-block text-xs text-muted hover:text-primary">
          ← {t('admin.openPanel')}
        </Link>
      </div>
    </main>
  );
}
