'use client';

/**
 * StoreIdentityForm — nombre de la tienda y dirección pública (slug).
 *
 * Solo se muestra mientras la tienda NO haya sido publicada: cambiar el slug de
 * una tienda activa rompería enlaces y pedidos sin redirect 301.
 *
 * El preview (`umantai.com/<slug>`) se actualiza al escribir y muestra
 * exactamente lo que se guardará: el servidor normaliza el slug con las mismas
 * reglas (`lib/store-identity.ts`), valida los reservados y comprueba la
 * unicidad case-insensitive contra la base.
 *
 * El slug es solo la dirección pública: no describe ni cambia la ubicación.
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useI18n } from '@/components/i18n/I18nProvider';
import {
  PUBLIC_STORE_HOST,
  publicStoreUrl,
  validateStoreIdentity,
} from '@/lib/store-identity';
import { normalizeStoreSlug } from '@/lib/tenancy';

interface Props {
  storeId: string;
  initialName: string;
  initialSlug: string;
}

interface PatchResponse {
  error?: string;
  code?: string;
  store?: { name: string; slug: string };
}

export function StoreIdentityForm({ storeId, initialName, initialSlug }: Props) {
  const { t } = useI18n();
  const router = useRouter();

  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const previewUrl = publicStoreUrl(slug);
  const dirty = name.trim() !== initialName || normalizeStoreSlug(slug) !== initialSlug;

  const messageFor = (code: string | undefined): string => {
    switch (code) {
      case 'invalid_name':
        return t('merchant.identityNameInvalid');
      case 'slug_too_short':
        return t('merchant.identitySlugShort');
      case 'slug_reserved':
      case 'store_slug_reserved':
        return t('merchant.identitySlugReserved');
      case 'store_slug_taken':
        return t('merchant.identitySlugTaken');
      default:
        return t('merchant.identityInvalid');
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const validation = validateStoreIdentity({ name, slug });
    if (!validation.ok) {
      setError(messageFor(validation.code));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validation.value),
      });
      const payload = (await response.json().catch(() => null)) as PatchResponse | null;

      if (!response.ok) {
        setError(payload?.code ? messageFor(payload.code) : payload?.error ?? t('merchant.identityFailed'));
        return;
      }

      setName(payload?.store?.name ?? validation.value.name);
      setSlug(payload?.store?.slug ?? validation.value.slug);
      toast.success(t('merchant.identitySaved'));
      router.refresh();
    } catch {
      setError(t('merchant.identityFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="field-label">{t('merchant.identityName')}</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
          autoComplete="organization"
          className="field-input h-11 text-body"
        />
      </label>

      <label className="block">
        <span className="field-label">{t('merchant.identityPublicAddress')}</span>
        <div className="flex h-11 items-center rounded-xl border border-border-strong bg-background px-3 transition-colors focus-within:border-primary">
          <span className="shrink-0 font-mono text-sm text-muted">{PUBLIC_STORE_HOST}/</span>
          <input
            type="text"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={60}
            required
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-body text-primary outline-none"
          />
        </div>
      </label>

      <div className="space-y-1">
        <p className="text-sm leading-relaxed text-secondary">{t('merchant.identityPublicHelp')}</p>
        <p className="text-sm leading-relaxed text-muted">{t('merchant.identitySlugHint')}</p>
        <p className="text-sm leading-relaxed text-muted">{t('merchant.identityNote')}</p>
      </div>

      <div className="rounded-xl border border-border bg-surface-raised/40 p-3 sm:p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[2px] text-muted">
          {t('merchant.identityPreview')}
        </p>
        <p className="mt-1 text-body font-medium text-primary">{name.trim() || '—'}</p>
        <p className="mt-0.5 break-all font-mono text-sm text-secondary">{previewUrl}</p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={saving || !dirty}
        className="btn-primary w-full text-sm sm:w-auto"
      >
        {saving ? t('merchant.identitySaving') : t('merchant.identitySave')}
      </button>
    </form>
  );
}
