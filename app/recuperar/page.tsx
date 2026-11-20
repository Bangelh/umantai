'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';

/** Correo con forma completa: algo@dominio.tld, sin espacios. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * /recuperar — solicitud de enlace de recuperación.
 *
 * Anti-enumeración: el mensaje de éxito es SIEMPRE el mismo, exista o no la
 * cuenta. El servidor (Better Auth) tampoco revela el resultado en la respuesta.
 *
 * El campo sigue las mismas reglas que el login: muestra el formato esperado
 * antes de escribir, valida mientras se escribe, usa teclado de correo y, al
 * enviar, lleva el foco al campo si no es válido.
 */
export default function RecoverPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const normalizedEmail = email.trim().toLowerCase();
  const emailOk = EMAIL_PATTERN.test(normalizedEmail);
  const showError = touched && !emailOk;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending) return;
    setTouched(true);
    if (!emailOk) {
      document.getElementById('recover-email')?.focus();
      return;
    }
    setSending(true);
    try {
      // Better Auth expone `/request-password-reset`; `/forget-password` no
      // existe y devolvía 404 silencioso (la UI mostraba éxito igual).
      await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: normalizedEmail, redirectTo: '/restablecer' }),
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
          <div className="mt-5 space-y-4">
            <p
              role="status"
              className="rounded-xl border border-border bg-surface-raised p-3 text-sm text-secondary"
            >
              {t('auth.resetSent')}
            </p>
            <Link
              href="/ingresar"
              className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-border-strong text-sm font-semibold text-primary underline-offset-2 hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {t('auth.backToLogin')}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
            <div className="text-xs text-tertiary">
              <label htmlFor="recover-email" className="block font-medium">
                {t('auth.email')}
              </label>
              <input
                id="recover-email"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setTouched(true);
                }}
                onBlur={() => {
                  // Al salir, un correo con espacios se guarda ya limpio.
                  setEmail((current) => current.trim());
                  setTouched(true);
                }}
                autoComplete="email"
                inputMode="email"
                placeholder={t('auth.emailPlaceholder')}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                maxLength={254}
                required
                aria-invalid={showError}
                aria-describedby="recover-email-hint"
                className={`mt-1 h-11 w-full rounded-xl border bg-background px-3 text-base text-primary focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                  showError ? 'border-destructive' : 'border-border-strong'
                }`}
              />
              <span
                id="recover-email-hint"
                aria-live="polite"
                className={`mt-1 block text-xs ${showError ? 'text-destructive' : 'text-muted'}`}
              >
                {showError ? t('auth.invalidEmail') : t('auth.emailRules')}
              </span>
            </div>

            <button
              type="submit"
              disabled={sending}
              aria-describedby={showError ? 'recover-email-hint' : undefined}
              className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {sending ? t('auth.sending') : t('auth.sendReset')}
            </button>
          </form>
        )}

        {!sent && (
          <p className="mt-5 text-center text-xs">
            <Link
              href="/ingresar"
              className="text-tertiary underline-offset-2 hover:text-primary hover:underline"
            >
              {t('auth.backToLogin')}
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
