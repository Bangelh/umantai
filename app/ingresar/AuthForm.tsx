'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

type Mode = 'login' | 'register';

interface Props {
  next: string;
}

interface AuthErrorPayload {
  message?: string;
  code?: string;
  error?: string;
}

export function AuthForm({ next }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setError(t('auth.invalidEmail'));
      return;
    }
    if (password.length < 8) {
      setError(t('auth.weakPassword'));
      return;
    }
    if (mode === 'register' && name.trim().length < 2) {
      setError(t('auth.nameRequired'));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const endpoint = mode === 'login' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email';
      const body =
        mode === 'login'
          ? { email: normalizedEmail, password }
          : { email: normalizedEmail, password, name: name.trim() };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as AuthErrorPayload | null;
        const message =
          payload?.message ??
          payload?.error ??
          (mode === 'login' ? t('auth.loginFailed') : t('auth.registerFailed'));
        throw new Error(message);
      }

      toast.success(mode === 'login' ? t('auth.welcomeBack') : t('auth.accountCreated'));
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.unexpected'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-3" noValidate>
      <div className="flex rounded-xl border border-border p-1" role="tablist" aria-label={t('auth.mode')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          onClick={() => {
            setMode('login');
            setError(null);
          }}
          className={`h-9 flex-1 rounded-lg text-sm font-medium transition-colors ${
            mode === 'login' ? 'bg-brand text-background' : 'text-secondary hover:text-primary'
          }`}
        >
          {t('auth.loginTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'register'}
          onClick={() => {
            setMode('register');
            setError(null);
          }}
          className={`h-9 flex-1 rounded-lg text-sm font-medium transition-colors ${
            mode === 'register' ? 'bg-brand text-background' : 'text-secondary hover:text-primary'
          }`}
        >
          {t('auth.registerTab')}
        </button>
      </div>

      {mode === 'register' && (
        <label className="block text-xs text-tertiary">
          {t('auth.name')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            maxLength={80}
            className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>
      )}

      <label className="block text-xs text-tertiary">
        {t('auth.email')}
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          inputMode="email"
          required
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="block text-xs text-tertiary">
        {t('auth.password')}
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={8}
          required
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
        <span className="mt-1 block text-[11px] text-muted">{t('auth.passwordHint')}</span>
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
        {submitting
          ? t('auth.processing')
          : mode === 'login'
            ? t('auth.submitLogin')
            : t('auth.submitRegister')}
      </button>

      <p className="text-center text-[11px] text-muted">{t('auth.guest')}</p>
    </form>
  );
}
