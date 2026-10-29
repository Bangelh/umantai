'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { LocationPicker, type StoreLocationValue } from '@/components/map/LocationPicker';
import { normalizeStoreSlug, validateStoreSlug } from '@/lib/tenancy';

interface CreatedStore {
  id: string;
  name: string;
  slug: string;
}

/** Resultado del aviso por correo que devuelve el alta de tienda. */
type CreatedEmail =
  | { status: 'sent' | 'stored' | 'disabled' | 'failed'; to?: string }
  | null;

export function MerchantOnboardingForm() {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState<StoreLocationValue | null>(null);
  const [contactPhone, setContactPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedStore | null>(null);
  const [createdEmail, setCreatedEmail] = useState<CreatedEmail>(null);

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
          // Ubicación estructurada: departamento/provincia/distrito los deriva la
          // base desde el UBIGEO. Si el comerciante la deja para después, la
          // tienda se crea igual y se completa desde el panel.
          location: location ?? undefined,
          contactPhone: contactPhone.trim() || null,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { store?: CreatedStore; error?: string; email?: CreatedEmail }
        | null;

      if (!response.ok || !payload?.store) {
        throw new Error(payload?.error ?? t('onboarding.createFailed'));
      }

      setCreated(payload.store);
      setCreatedEmail(payload.email ?? null);
      toast.success(t('onboarding.created'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('onboarding.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    // La tarjeta de éxito responde las tres preguntas del usuario: qué pasó,
    // qué sigue y si el correo salió. Nunca deja "¿funcionó o no?".
    const emailSent = createdEmail?.status === 'sent';
    const emailPending = createdEmail?.status === 'stored';

    return (
      <div className="mt-4 rounded-2xl border-2 border-success/50 bg-success/10 p-5">
        <h3 className="text-xl font-semibold text-success">✓ {t('onboarding.created')}</h3>
        <p className="mt-2 text-base text-secondary">
          <strong>{created.name}</strong> {t('onboarding.createdBody')}
        </p>

        <h4 className="mt-5 text-sm font-semibold uppercase tracking-[1.5px] text-secondary">
          {t('onboarding.nextStepsTitle')}
        </h4>
        <ol className="mt-2 space-y-1.5 text-base text-secondary">
          <li>{t('onboarding.nextStepCatalog')}</li>
          <li>{t('onboarding.nextStepReview')}</li>
          <li>{t('onboarding.nextStepStorefront', { slug: created.slug })}</li>
        </ol>

        <p className="mt-4 rounded-xl bg-background/60 p-3 text-sm text-tertiary" role="status">
          {emailSent
            ? t('onboarding.emailSent', { email: createdEmail?.to ?? '' })
            : emailPending
              ? t('onboarding.emailTestMode')
              : t('onboarding.emailNotSent')}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/negocio/${created.id}`}
            className="inline-flex h-12 items-center rounded-xl bg-brand px-5 text-base font-semibold text-background"
          >
            {t('onboarding.goPanel')}
          </Link>
          <span className="inline-flex min-h-12 items-center rounded-xl border border-border px-4 text-sm text-tertiary">
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

      <div className="mt-2 sm:col-span-2">
        <LocationPicker
          onValueChange={setLocation}
          hideSubmit
          submitLabel={t('onboarding.create')}
          onSubmit={async () => undefined}
        />
      </div>

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
