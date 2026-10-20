'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/components/i18n/I18nProvider';

export function SignOutButton() {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const signOut = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'same-origin',
      });
    } finally {
      router.push('/');
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={loading}
      className="shrink-0 rounded-full border border-border-strong px-3 py-1.5 text-xs text-secondary hover:bg-surface-raised disabled:opacity-50"
    >
      {loading ? t('account.signingOut') : t('account.signOut')}
    </button>
  );
}
