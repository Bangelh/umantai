'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';

type Field = 'password' | 'confirm';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function ResetForm() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState<Record<Field, boolean>>({
    password: false,
    confirm: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordOk = password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
  const confirmMissing = confirm.length === 0;
  const confirmOk = !confirmMissing && confirm === password;
  const showPasswordError = touched.password && !passwordOk;
  const showConfirmError = touched.confirm && !confirmOk;
  const showMissing = (touched.password || touched.confirm) && (!passwordOk || !confirmOk);

  const markTouched = (field: Field) =>
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setTouched({ password: true, confirm: true });

    if (!passwordOk) {
      document.getElementById('reset-password')?.focus();
      return;
    }
    if (!confirmOk) {
      document.getElementById('reset-confirm')?.focus();
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
          className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand text-sm font-semibold text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {t('auth.submitLogin')}
        </Link>
      </div>
    );
  }

  // Sin token no hay nada que completar: se avisa antes de escribir y se ofrece
  // pedir un enlace nuevo, en lugar de fallar recién al enviar.
  if (!token) {
    return (
      <div className="mt-5 space-y-4">
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {t('auth.resetInvalid')}
        </p>
        <Link
          href="/recuperar"
          className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand text-sm font-semibold text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {t('auth.requestNewLink')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
      <div className="text-xs text-tertiary">
        <label htmlFor="reset-password" className="block font-medium">
          {t('account.newPassword')}
        </label>
        <input
          id="reset-password"
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            markTouched('password');
          }}
          onBlur={() => markTouched('password')}
          autoComplete="new-password"
          placeholder={t('auth.passwordPlaceholderRegister')}
          enterKeyHint="next"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
          aria-invalid={showPasswordError}
          aria-describedby="reset-password-hint"
          className={`mt-1 h-11 w-full rounded-xl border bg-background px-3 text-base text-primary focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
            showPasswordError ? 'border-destructive' : 'border-border-strong'
          }`}
        />
        <span
          id="reset-password-hint"
          className={`mt-1 block text-xs ${
            showPasswordError ? 'text-destructive' : 'text-muted'
          }`}
        >
          {showPasswordError ? t('auth.weakPassword') : t('auth.passwordHint')}
        </span>
      </div>

      <div className="text-xs text-tertiary">
        <label htmlFor="reset-confirm" className="block font-medium">
          {t('account.confirmPassword')}
        </label>
        <input
          id="reset-confirm"
          type="password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            markTouched('confirm');
          }}
          onBlur={() => markTouched('confirm')}
          autoComplete="new-password"
          placeholder={t('auth.confirmPasswordPlaceholder')}
          enterKeyHint="done"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
          aria-invalid={showConfirmError}
          aria-describedby="reset-confirm-hint"
          className={`mt-1 h-11 w-full rounded-xl border bg-background px-3 text-base text-primary focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
            showConfirmError ? 'border-destructive' : 'border-border-strong'
          }`}
        />
        <span
          id="reset-confirm-hint"
          className={`mt-1 block text-xs ${
            showConfirmError ? 'text-destructive' : 'text-muted'
          }`}
        >
          {!touched.confirm
            ? t('auth.confirmPasswordRules')
            : confirmMissing
              ? t('auth.confirmPasswordRequired')
              : confirmOk
                ? t('auth.confirmPasswordRules')
                : t('account.passwordMismatch')}
        </span>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        aria-describedby={showMissing ? 'reset-missing' : undefined}
        className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {submitting ? t('auth.processing') : t('auth.resetSubmit')}
      </button>

      {showMissing && (
        <ul id="reset-missing" aria-live="polite" className="space-y-0.5 text-xs text-secondary">
          {!passwordOk && (
            <li>• {password.length === 0 ? t('auth.missingPassword') : t('auth.weakPassword')}</li>
          )}
          {!confirmOk && (
            <li>• {confirmMissing ? t('auth.confirmPasswordRequired') : t('account.passwordMismatch')}</li>
          )}
        </ul>
      )}
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
