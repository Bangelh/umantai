'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * /recuperar — solicitud de enlace de recuperación.
 *
 * Anti-enumeración: el mensaje de éxito es SIEMPRE el mismo, exista o no la
 * cuenta. El servidor (Better Auth) tampoco revela el resultado en la respuesta.
 */
export default function RecoverPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    try {
      await fetch('/api/auth/forget-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: email.trim().toLowerCase(), redirectTo: '/restablecer' }),
      });
    } catch {
      // La respuesta al usuario no cambia: evita distinguir correos existentes.
    } finally {
      setSending(false);
      setSent(true);
    }
  };

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('auth.forgotTitle')}</h1>
        <p className="mt-1 text-sm text-secondary">{t('auth.forgotBody')}</p>

        {sent ? (
          <p role="status" className="mt-5 rounded-xl border border-border bg-surface-raised p-3 text-sm text-secondary">
            {t('auth.resetSent')}
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <label className="block text-xs text-tertiary">
              {t('auth.email')}
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
                className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
              />
            </label>
            <button
              type="submit"
              disabled={sending}
              className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50"
            >
              {sending ? t('auth.sending') : t('auth.sendReset')}
            </button>
          </form>
        )}

        <p className="mt-5 text-center text-xs">
          <Link href="/ingresar" className="text-tertiary underline-offset-2 hover:text-primary hover:underline">
            {t('auth.backToLogin')}
          </Link>
        </p>
      </div>
    </main>
  );
}
