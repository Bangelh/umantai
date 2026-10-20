'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { formatDateTime } from '@/lib/format';

interface SessionRow {
  id?: string;
  token?: string;
  expiresAt?: string;
  userAgent?: string | null;
}

export function SecurityPanel() {
  const { locale, t } = useI18n();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changing, setChanging] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/auth/list-sessions', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error('sessions_unavailable');
        const payload = (await response.json()) as SessionRow[] | { sessions?: SessionRow[] };
        const list = Array.isArray(payload) ? payload : payload.sessions ?? [];
        if (!cancelled) setSessions(list);
      } catch {
        if (!cancelled) setSessionsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const revokeOthers = async () => {
    if (revoking) return;
    setRevoking(true);
    try {
      const response = await fetch('/api/auth/revoke-other-sessions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error('revoke_failed');
      toast.success(t('account.sessionsRevoked'));
      setSessions((current) => (current ? current.slice(0, 1) : current));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setRevoking(false);
    }
  };

  const changePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (changing) return;
    setFormError(null);

    if (newPassword.length < 8) {
      setFormError(t('account.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError(t('account.passwordMismatch'));
      return;
    }

    setChanging(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          // Cierra el resto de sesiones al cambiar credenciales.
          revokeOtherSessions: true,
        }),
      });
      if (!response.ok) throw new Error('password_change_failed');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('account.passwordChanged'));
      setSessions((current) => (current ? current.slice(0, 1) : current));
    } catch {
      setFormError(t('account.passwordChangeFailed'));
    } finally {
      setChanging(false);
    }
  };

  const currentSession = sessions?.[0];

  return (
    <div className="mt-3 grid gap-4 md:grid-cols-2">
      <form onSubmit={changePassword} className="rounded-2xl border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold">{t('account.changePassword')}</h3>
        <label className="mt-3 block text-xs text-tertiary">
          {t('account.currentPassword')}
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>
        <label className="mt-2 block text-xs text-tertiary">
          {t('account.newPassword')}
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>
        <label className="mt-2 block text-xs text-tertiary">
          {t('account.confirmPassword')}
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>
        {formError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={changing}
          className="mt-3 h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50"
        >
          {changing ? t('account.saving') : t('account.changePassword')}
        </button>
      </form>

      <div className="rounded-2xl border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold">{t('account.sessions')}</h3>
        {sessionsError ? (
          <p className="mt-2 text-xs text-tertiary">{t('common.error')}</p>
        ) : sessions === null ? (
          <p className="mt-2 text-xs text-tertiary">{t('common.loading')}</p>
        ) : (
          <>
            <p className="mt-2 text-xs text-tertiary">
              {sessions.length} ·{' '}
              {currentSession?.expiresAt
                ? t('account.sessionExpires', {
                    date: formatDateTime(currentSession.expiresAt, locale),
                  })
                : ''}
            </p>
            <button
              type="button"
              onClick={() => void revokeOthers()}
              disabled={revoking || sessions.length <= 1}
              className="mt-3 h-10 rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised disabled:opacity-50"
            >
              {t('account.signOutOthers')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
