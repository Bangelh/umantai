'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

type Mode = 'login' | 'register';

interface Props {
  next: string;
  /** Pestaña inicial; permite que «Crear cuenta de negocio» abra registro. */
  initialMode?: Mode;
  /**
   * Recarga completa después de autenticar. El panel de administración lo usa
   * para que el hook de sesión vuelva a arrancar y canjee la cuenta por la
   * cookie de Platform Admin.
   */
  fullReload?: boolean;
}

interface AuthErrorPayload {
  message?: string;
  code?: string;
  error?: string;
}

type Field = 'name' | 'email' | 'password';

/** Correo con forma completa: algo@dominio.tld, sin espacios. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Ingreso y registro comparten formulario y ahora comparten reglas visibles.
 *
 * Antes los errores aparecían uno por uno al enviar ("ingresa un correo",
 * luego "contraseña corta", luego "nombre"), así que había que fallar tres
 * veces para saber qué faltaba. Ahora cada campo muestra su regla antes de
 * escribir, valida mientras se escribe, usa el teclado correcto y el botón dice
 * qué queda pendiente.
 *
 * Las etiquetas visibles («Nombre», «Correo», «Contraseña») se conservan: la
 * suite E2E las localiza por texto exacto.
 */
export function AuthForm({ next, initialMode = 'login', fullReload = false }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<Field, boolean>>({
    name: false,
    email: false,
    password: false,
  });

  const markTouched = (field: Field) =>
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  const trimmedName = name.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const nameOk = mode !== 'register' || (trimmedName.length >= 2 && trimmedName.length <= 80);
  const emailOk = EMAIL_PATTERN.test(normalizedEmail);
  // En el login solo importa que haya contraseña: una cuenta antigua pudo
  // tener una más corta que la regla actual y no se le puede bloquear la entrada.
  const passwordOk =
    mode === 'login'
      ? password.length > 0
      : password.length >= 8 && password.length <= 128;
  const canSubmit = nameOk && emailOk && passwordOk;

  const missing: string[] = [];
  if (!nameOk) missing.push(t('auth.missingName'));
  if (!emailOk) missing.push(t('auth.missingEmail'));
  if (!passwordOk) {
    missing.push(mode === 'login' ? t('auth.missingPasswordLogin') : t('auth.missingPassword'));
  }

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setError(null);
    // El nombre solo existe en registro; al volver al login no debe estorbar.
    setTouched({ name: false, email: false, password: false });
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setTouched({ name: true, email: true, password: true });
    if (!canSubmit) {
      setError(null);
      const firstInvalid = !nameOk ? 'auth-name' : !emailOk ? 'auth-email' : 'auth-password';
      document.getElementById(firstInvalid)?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const endpoint = mode === 'login' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email';
      const body =
        mode === 'login'
          ? { email: normalizedEmail, password }
          : { email: normalizedEmail, password, name: trimmedName };

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
      if (mode === 'register') toast.info(t('auth.verifySent'));
      if (fullReload) {
        window.location.assign(next);
        return;
      }
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
          onClick={() => switchMode('login')}
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
          onClick={() => switchMode('register')}
          className={`h-9 flex-1 rounded-lg text-sm font-medium transition-colors ${
            mode === 'register' ? 'bg-brand text-background' : 'text-secondary hover:text-primary'
          }`}
        >
          {t('auth.registerTab')}
        </button>
      </div>

      {mode === 'register' && (
        <div className="text-xs text-tertiary">
          <label htmlFor="auth-name" className="block">
            {t('auth.name')}
          </label>
          <input
            id="auth-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              markTouched('name');
            }}
            onBlur={() => markTouched('name')}
            autoComplete="name"
            enterKeyHint="next"
            maxLength={80}
            aria-invalid={touched.name && !nameOk}
            aria-describedby="auth-name-hint"
            className={`mt-1 h-11 w-full rounded-xl border bg-background px-3 text-sm text-primary ${
              touched.name && !nameOk ? 'border-destructive' : 'border-border-strong'
            }`}
          />
          <span
            id="auth-name-hint"
            className={`mt-1 block text-[11px] ${
              touched.name && !nameOk ? 'text-destructive' : 'text-muted'
            }`}
          >
            {touched.name && !nameOk ? t('auth.nameRequired') : t('auth.nameRules')}
          </span>
        </div>
      )}

      <div className="text-xs text-tertiary">
        <label htmlFor="auth-email" className="block">
          {t('auth.email')}
        </label>
        <input
          id="auth-email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            markTouched('email');
          }}
          onBlur={() => {
            // Al salir, un correo con espacios se guarda ya limpio.
            setEmail((current) => current.trim());
            markTouched('email');
          }}
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          maxLength={254}
          required
          aria-invalid={touched.email && !emailOk}
          aria-describedby="auth-email-hint"
          className={`mt-1 h-11 w-full rounded-xl border bg-background px-3 text-sm text-primary ${
            touched.email && !emailOk ? 'border-destructive' : 'border-border-strong'
          }`}
        />
        <span
          id="auth-email-hint"
          className={`mt-1 block text-[11px] ${
            touched.email && !emailOk ? 'text-destructive' : 'text-muted'
          }`}
        >
          {touched.email && !emailOk ? t('auth.invalidEmail') : t('auth.emailRules')}
        </span>
      </div>

      <div className="text-xs text-tertiary">
        <label htmlFor="auth-password" className="block">
          {t('auth.password')}
        </label>
        <input
          id="auth-password"
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            markTouched('password');
          }}
          onBlur={() => markTouched('password')}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          enterKeyHint={mode === 'login' ? 'go' : 'done'}
          minLength={mode === 'login' ? undefined : 8}
          maxLength={128}
          required
          aria-invalid={touched.password && !passwordOk}
          aria-describedby={mode === 'register' ? 'auth-password-hint' : undefined}
          className={`mt-1 h-11 w-full rounded-xl border bg-background px-3 text-sm text-primary ${
            touched.password && !passwordOk ? 'border-destructive' : 'border-border-strong'
          }`}
        />
        {mode === 'register' && (
          <span
            id="auth-password-hint"
            className={`mt-1 block text-[11px] ${
              touched.password && !passwordOk ? 'text-destructive' : 'text-muted'
            }`}
          >
            {touched.password && !passwordOk ? t('auth.weakPassword') : t('auth.passwordHint')}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        aria-describedby={missing.length > 0 ? 'auth-missing' : undefined}
        className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50"
      >
        {submitting
          ? t('auth.processing')
          : mode === 'login'
            ? t('auth.submitLogin')
            : t('auth.submitRegister')}
      </button>

      {missing.length > 0 && (
        <ul id="auth-missing" className="space-y-0.5 text-[11px] text-tertiary">
          {missing.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      )}

      {mode === 'login' && (
        <p className="text-center text-xs">
          <Link
            href="/recuperar"
            className="text-tertiary underline-offset-2 hover:text-primary hover:underline"
          >
            {t('auth.forgot')}
          </Link>
        </p>
      )}
    </form>
  );
}
