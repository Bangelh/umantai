'use client';

/**
 * Tarjeta de verificación de correo de /cuenta.
 *
 * Antes la página imprimía "Correo sin verificar" sin ninguna acción: el usuario
 * no podía verificar su cuenta. Ahora, cuando `emailVerified === false`, muestra
 * el estado, explica para qué sirve y ofrece el reenvío con feedback real
 * (enviado / cooldown / error) sin preguntar el correo: lo resuelve el servidor
 * desde la sesión, así que esta UI no puede usarse para sondear cuentas ajenas.
 */

import { useEffect, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';

type Feedback =
  | { kind: 'success' }
  | { kind: 'error'; message: string }
  | null;

interface Props {
  verified: boolean;
}

export function EmailVerificationCard({ verified }: Props) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // Cuenta atrás visible: el botón vuelve solo cuando el cupo está libre.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((value) => (value <= 1 ? 0 : value - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  if (verified) {
    return (
      <p className="mt-3 rounded-2xl border border-success/40 bg-success/10 p-3 text-sm text-success">
        <span className="font-semibold">{t('account.emailVerified')}</span>
        {' · '}
        {t('account.emailVerifiedBody')}
      </p>
    );
  }

  const resend = async () => {
    if (sending || cooldown > 0) return;
    setSending(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/account/verification/resend', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; status?: string; code?: string; retryAfterSeconds?: number }
        | null;

      if (response.status === 429) {
        setCooldown(Math.max(1, payload?.retryAfterSeconds ?? 60));
        return;
      }
      if (response.ok && payload?.status === 'sent') {
        setFeedback({ kind: 'success' });
        setCooldown(60);
        return;
      }
      if (response.ok && payload?.status === 'already_verified') {
        // Otra pestaña ya verificó la cuenta: recarga para reflejarlo.
        window.location.reload();
        return;
      }
      setFeedback({
        kind: 'error',
        message:
          payload?.code === 'email_unavailable'
            ? t('account.verificationUnavailable')
            : t('account.verificationFailed'),
      });
    } catch {
      setFeedback({ kind: 'error', message: t('account.verificationFailed') });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
      <p className="text-sm font-semibold text-warning">{t('account.emailUnverified')}</p>
      <p className="mt-1 text-sm text-secondary" id="email-verification-help">
        {t('account.emailUnverifiedBody')}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={sending || cooldown > 0}
          aria-describedby="email-verification-help"
          className="h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50"
        >
          {sending ? t('account.resendingVerification') : t('account.resendVerification')}
        </button>
        {cooldown > 0 && (
          <span className="text-xs text-tertiary tabular-nums" role="status">
            {t('account.verificationCooldown', { seconds: cooldown })}
          </span>
        )}
      </div>

      {feedback?.kind === 'success' && (
        <p role="status" className="mt-2 text-xs text-success">
          {t('account.verificationSent')}
        </p>
      )}
      {feedback?.kind === 'error' && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {feedback.message}
        </p>
      )}
    </div>
  );
}
