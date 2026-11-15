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

type CreatedEmail =
  | { status: 'sent' | 'stored' | 'disabled' | 'failed'; to?: string }
  | null;

type Step = 1 | 2 | 3;

/**
 * Alta de tienda en TRES pasos cortos.
 *
 * Antes se pedía todo de una vez: nombre, dirección pública, rubro, teléfono,
 * descripción, departamento/provincia/distrito y ubicación. Para una persona que
 * no maneja mucha tecnología eso es una pared. Ahora:
 *
 *   1. Lo esencial: nombre, rubro y WhatsApp.
 *   2. Ubicación OPCIONAL (se puede completar después desde el panel).
 *   3. Cómo cobrar (Yape/Plin/cuenta/efectivo), también opcional.
 *
 * El enlace público se genera solo con el nombre; no se pide escribirlo.
 */
export function MerchantOnboardingForm() {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [location, setLocation] = useState<StoreLocationValue | null>(null);
  const [yape, setYape] = useState('');
  const [plin, setPlin] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [holder, setHolder] = useState('');
  const [cash, setCash] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedStore | null>(null);
  const [createdEmail, setCreatedEmail] = useState<CreatedEmail>(null);

  const slugValidation = useMemo(
    () => validateStoreSlug(normalizeStoreSlug(name)),
    [name],
  );

  const goToLocation = () => {
    if (name.trim().length < 2) {
      toast.error(t('onboarding.nameRequired'));
      return;
    }
    if (!slugValidation.ok) {
      toast.error(slugValidation.message);
      return;
    }
    setStep(2);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    if (name.trim().length < 2) {
      setStep(1);
      toast.error(t('onboarding.nameRequired'));
      return;
    }
    if (!slugValidation.ok) {
      setStep(1);
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
          location: location ?? undefined,
          contactPhone: contactPhone.trim() || null,
          payments: {
            yape: yape.trim() || null,
            plin: plin.trim() || null,
            bankAccount: bankAccount.trim() || null,
            holder: holder.trim() || null,
            cash,
          },
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
    <form onSubmit={submit} className="mt-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-2" aria-label={t('onboarding.progress')}>
        {([1, 2, 3] as Step[]).map((item) => (
          <div
            key={item}
            className={`h-1.5 flex-1 rounded-full ${item <= step ? 'bg-brand' : 'bg-border'}`}
          />
        ))}
      </div>
      <p className="mt-2 text-xs font-medium uppercase tracking-[1.5px] text-tertiary">
        {t('onboarding.stepOf', { current: step, total: 3 })}
      </p>

      {step === 1 && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <h2 className="text-lg font-semibold">{t('onboarding.step1Title')}</h2>
            <p className="mt-1 text-sm text-tertiary">{t('onboarding.step1Body')}</p>
          </div>

          <label className="text-sm text-secondary sm:col-span-2">
            {t('onboarding.businessName')} *
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoFocus
              className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary"
            />
            {name.trim().length >= 2 && (
              <span className="mt-1 block text-xs text-tertiary">
                {t('onboarding.slugAuto', {
                  slug: slugValidation.ok ? slugValidation.slug : normalizeStoreSlug(name),
                })}
              </span>
            )}
          </label>

          <label className="text-sm text-secondary">
            {t('onboarding.category')}
            <input
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              list="merchant-categories"
              maxLength={60}
              placeholder={t('onboarding.categoryPlaceholder')}
              className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary"
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

          <label className="text-sm text-secondary">
            {t('onboarding.phone')}
            <input
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              inputMode="tel"
              maxLength={30}
              placeholder="987 654 321"
              className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base text-primary"
            />
            <span className="mt-1 block text-xs text-tertiary">{t('onboarding.phoneHint')}</span>
          </label>

          <label className="text-sm text-secondary sm:col-span-2">
            {t('onboarding.description')} <span className="text-xs text-muted">({t('common.optional')})</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={400}
              rows={2}
              className="mt-1 w-full rounded-xl border border-border-strong bg-background px-3 py-2 text-base text-primary"
            />
          </label>

          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={goToLocation}
              className="h-12 w-full rounded-xl bg-brand px-6 text-base font-semibold text-background sm:w-auto"
            >
              {t('onboarding.continue')} →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-4">
          <h2 className="text-lg font-semibold">{t('onboarding.step2Title')}</h2>
          <p className="mt-1 text-sm text-tertiary">{t('onboarding.step2Body')}</p>

          <div className="mt-3">
            <LocationPicker
              onValueChange={setLocation}
              hideSubmit
              submitLabel={t('onboarding.continue')}
              onSubmit={async () => undefined}
            />
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setStep(3)}
              className="h-12 flex-1 rounded-xl bg-brand px-5 text-base font-semibold text-background"
            >
              {t('onboarding.continue')} →
            </button>
            <button
              type="button"
              onClick={() => {
                setLocation(null);
                setStep(3);
              }}
              className="h-12 rounded-xl border border-border-strong px-5 text-sm text-secondary hover:bg-surface-raised"
            >
              {t('onboarding.skip')}
            </button>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="h-12 rounded-xl px-4 text-sm text-tertiary hover:text-primary"
            >
              ← {t('onboarding.back')}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-4">
          <h2 className="text-lg font-semibold">{t('onboarding.step3Title')}</h2>
          <p className="mt-1 text-sm text-tertiary">{t('onboarding.step3Body')}</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-secondary">
              {t('merchant.paymentsYape')}
              <input
                value={yape}
                onChange={(event) => setYape(event.target.value)}
                inputMode="tel"
                maxLength={20}
                placeholder="987 654 321"
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base"
              />
            </label>

            <label className="block text-sm text-secondary">
              {t('merchant.paymentsPlin')}
              <input
                value={plin}
                onChange={(event) => setPlin(event.target.value)}
                inputMode="tel"
                maxLength={20}
                placeholder="987 654 321"
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base"
              />
            </label>

            <label className="block text-sm text-secondary">
              {t('merchant.paymentsBank')}
              <input
                value={bankAccount}
                onChange={(event) => setBankAccount(event.target.value)}
                maxLength={60}
                placeholder="BCP · 193-1234567-0-12"
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base"
              />
            </label>

            <label className="block text-sm text-secondary">
              {t('merchant.paymentsHolder')}
              <input
                value={holder}
                onChange={(event) => setHolder(event.target.value)}
                maxLength={80}
                placeholder={t('merchant.paymentsHolderPlaceholder')}
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base"
              />
            </label>

            <label className="flex items-start gap-2 rounded-xl border border-border bg-background p-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={cash}
                onChange={(event) => setCash(event.target.checked)}
                className="mt-0.5 h-5 w-5 accent-[var(--um-brand)]"
              />
              <span>
                <span className="block text-sm font-medium">{t('merchant.paymentsCash')}</span>
                <span className="mt-0.5 block text-xs text-tertiary">
                  {t('merchant.paymentsCashHint')}
                </span>
              </span>
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              disabled={submitting}
              className="h-12 flex-1 rounded-xl bg-brand px-5 text-base font-semibold text-background disabled:opacity-40"
            >
              {submitting ? t('onboarding.creating') : t('onboarding.create')}
            </button>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="h-12 rounded-xl px-4 text-sm text-tertiary hover:text-primary"
            >
              ← {t('onboarding.back')}
            </button>
          </div>
          <p className="mt-2 text-xs text-tertiary">{t('onboarding.paymentsLater')}</p>
        </div>
      )}
    </form>
  );
}
