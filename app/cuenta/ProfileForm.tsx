'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

interface Props {
  initial: {
    fullName: string;
    phone: string;
    docType: string;
    docNumber: string;
  };
}

export function ProfileForm({ initial }: Props) {
  const { t } = useI18n();
  const [fullName, setFullName] = useState(initial.fullName);
  const [phone, setPhone] = useState(initial.phone);
  const [docType, setDocType] = useState(initial.docType);
  const [docNumber, setDocNumber] = useState(initial.docNumber);
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);

    try {
      const response = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: fullName.trim() || null,
          phone: phone.trim() || null,
          docType: docType.trim() || null,
          docNumber: docNumber.trim() || null,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? t('account.saveFailed'));
      }
      toast.success(t('account.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('account.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="text-xs text-tertiary sm:col-span-2">
        {t('account.fullName')}
        <input
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          maxLength={120}
          autoComplete="name"
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary">
        {t('account.phone')}
        <input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={30}
          inputMode="tel"
          autoComplete="tel"
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary">
        {t('account.document')}
        <span className="mt-1 flex gap-2">
          <input
            value={docType}
            onChange={(event) => setDocType(event.target.value.toUpperCase())}
            maxLength={4}
            placeholder="DNI"
            aria-label={t('account.docType')}
            className="h-11 w-16 rounded-xl border border-border-strong bg-background px-3 text-sm uppercase"
          />
          <input
            value={docNumber}
            onChange={(event) => setDocNumber(event.target.value)}
            maxLength={20}
            inputMode="numeric"
            placeholder="12345678"
            aria-label={t('account.docNumber')}
            className="h-11 min-w-0 flex-1 rounded-xl border border-border-strong bg-background px-3 text-sm"
          />
        </span>
      </label>

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={saving}
          className="h-10 rounded-xl bg-brand px-5 text-sm font-semibold text-background disabled:opacity-50"
        >
          {saving ? t('account.saving') : t('account.save')}
        </button>
      </div>
    </form>
  );
}
