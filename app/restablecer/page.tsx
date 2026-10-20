'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';

function ResetForm() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (!token) {
      setError(t('auth.resetInvalid'));
      return;
    }
    if (password.length < 8) {
      setError(t('account.passwordTooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('account.passwordMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (!response.ok) throw new Error('reset_failed');
      setDone(true);
    } catch {
      setError(t('auth.resetInvalid'));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div>
        <p role="status" className="rounded-xl border border-success/40 bg-success/10 p-3 text-sm text-success">
          {t('auth.resetDone')}
        </p>
        <Link
          href="/ingresar"
          className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand text-sm font-semibold text-background"
        >
          {t('auth.submitLogin')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
      <label className="block text-xs text-tertiary">
        {t('account.newPassword')}
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>
      <label className="block text-xs text-tertiary">
        {t('account.confirmPassword')}
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50"
      >
        {submitting ? t('auth.processing') : t('auth.resetSubmit')}
      </button>
    </form>
  );
}

export default function ResetPage() {
  const { t } = useI18n();
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('auth.resetTitle')}</h1>
        <p className="mt-1 text-sm text-secondary">{t('auth.resetBody')}</p>
        <Suspense fallback={<p className="mt-5 text-sm text-tertiary">{t('common.loading')}</p>}>
          <ResetForm />
        </Suspense>
      </div>
    </main>
  );
}
