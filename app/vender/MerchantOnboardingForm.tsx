'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { LOCATION_PRESETS } from '@/lib/locations';
import { normalizeStoreSlug, validateStoreSlug } from '@/lib/tenancy';

interface CreatedStore {
  id: string;
  name: string;
  slug: string;
}

export function MerchantOnboardingForm() {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [district, setDistrict] = useState('');
  const [city, setCity] = useState('Lima');
  const [zoneId, setZoneId] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedStore | null>(null);

  const effectiveSlug = slugTouched ? slug : normalizeStoreSlug(name);
  const slugValidation = useMemo(() => validateStoreSlug(effectiveSlug || name), [effectiveSlug, name]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    if (name.trim().length < 2) {
      toast.error(t('onboarding.nameRequired'));
      return;
    }
    if (!slugValidation.ok) {
      toast.error(slugValidation.message);
      return;
    }

    const zone = LOCATION_PRESETS.find((item) => item.id === zoneId) ?? null;

    setSubmitting(true);
    try {
      const response = await fetch('/api/merchant/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          slug: slugValidation.slug,
          category: category.trim() || null,
          description: description.trim() || null,
          address: address.trim() || null,
          district: district.trim() || zone?.label || null,
          city: city.trim() || null,
          latitude: zone?.latitude ?? null,
          longitude: zone?.longitude ?? null,
          contactPhone: contactPhone.trim() || null,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { store?: CreatedStore; error?: string }
        | null;

      if (!response.ok || !payload?.store) {
        throw new Error(payload?.error ?? t('onboarding.createFailed'));
      }

      setCreated(payload.store);
      toast.success(t('onboarding.created'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('onboarding.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <div className="mt-4 rounded-2xl border border-success/40 bg-success/10 p-5">
        <h3 className="text-lg font-semibold text-success">{t('onboarding.created')}</h3>
        <p className="mt-1 text-sm text-secondary">
          <strong>{created.name}</strong> {t('onboarding.createdBody')}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/negocio/${created.id}`}
            className="inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-background"
          >
            {t('onboarding.goPanel')}
          </Link>
          <span className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm text-tertiary">
            {t('onboarding.storefrontPending', { slug: created.slug })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="text-xs text-tertiary sm:col-span-2">
        {t('onboarding.businessName')} *
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary sm:col-span-2">
        {t('onboarding.publicAddress')} *
        <span className="mt-1 flex items-center rounded-xl border border-border-strong bg-background">
          <span className="pl-3 text-sm text-muted">umantai.com/</span>
          <input
            value={effectiveSlug}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(event.target.value);
            }}
            maxLength={60}
            required
            className="h-11 min-w-0 flex-1 bg-transparent px-1 text-sm text-primary outline-none"
          />
        </span>
        {!slugValidation.ok && effectiveSlug.length > 0 && (
          <span className="mt-1 block text-[11px] text-destructive">{slugValidation.message}</span>
        )}
      </label>

      <label className="text-xs text-tertiary">
        {t('onboarding.category')}
        <input
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          list="merchant-categories"
          maxLength={60}
          placeholder={t('onboarding.categoryPlaceholder')}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
        <datalist id="merchant-categories">
          <option value="abarrotes" />
          <option value="ropa" />
          <option value="telas" />
          <option value="calzado" />
          <option value="ferretería" />
          <option value="belleza" />
          <option value="tecnología" />
          <option value="otros" />
        </datalist>
      </label>

      <label className="text-xs text-tertiary">
        {t('onboarding.phone')}
        <input
          value={contactPhone}
          onChange={(event) => setContactPhone(event.target.value)}
          inputMode="tel"
          maxLength={30}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary sm:col-span-2">
        {t('onboarding.description')}
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={400}
          rows={2}
          className="mt-1 w-full rounded-xl border border-border-strong bg-background px-3 py-2 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary sm:col-span-2">
        {t('onboarding.address')}
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={160}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary">
        {t('onboarding.zone')}
        <select
          value={zoneId}
          onChange={(event) => {
            setZoneId(event.target.value);
            const zone = LOCATION_PRESETS.find((item) => item.id === event.target.value);
            if (zone) setDistrict(zone.label);
          }}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        >
          <option value="">{t('onboarding.selectZone')}</option>
          {LOCATION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label} · {preset.region}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-tertiary">
        {t('onboarding.district')}
        <input
          value={district}
          onChange={(event) => setDistrict(event.target.value)}
          maxLength={60}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <label className="text-xs text-tertiary">
        {t('onboarding.city')}
        <input
          value={city}
          onChange={(event) => setCity(event.target.value)}
          maxLength={60}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
        />
      </label>

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={submitting || !slugValidation.ok}
          className="h-11 rounded-xl bg-brand px-6 text-sm font-semibold text-background disabled:opacity-40"
        >
          {submitting ? t('onboarding.creating') : t('onboarding.create')}
        </button>
        <p className="mt-2 text-[11px] text-muted">
          {t('onboarding.hiddenNote')}
        </p>
      </div>
    </form>
  );
}
