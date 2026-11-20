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

type TouchableField = 'name' | 'phone' | 'yape' | 'plin';

/** Celular peruano: 9 dígitos que empiezan con 9. */
const PERU_MOBILE = /^9\d{8}$/;

/** Solo dígitos, recortado a 9: el campo no deja escribir de más. */
function digits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 9);
}

/** Escribe el número como la gente lo lee: 987 654 321. */
function formatPeruPhone(value: string): string {
  const d = digits(value);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** Un campo opcional está bien vacío, pero si hay algo debe ser un celular. */
function phoneState(formatted: string): 'empty' | 'valid' | 'invalid' {
  const d = digits(formatted);
  if (d.length === 0) return 'empty';
  return PERU_MOBILE.test(d) ? 'valid' : 'invalid';
}

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
 *
 * Reglas de los campos visibles ANTES de escribir, validación mientras se
 * escribe, teclado numérico en teléfonos y el botón dice qué falta para seguir.
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
  const [touched, setTouched] = useState<Record<TouchableField, boolean>>({
    name: false,
    phone: false,
    yape: false,
    plin: false,
  });

  const markTouched = (field: TouchableField) =>
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  const trimmedName = name.trim();
  const nameLengthOk = trimmedName.length >= 3 && trimmedName.length <= 80;
  const slugValidation = useMemo(
    () => validateStoreSlug(normalizeStoreSlug(trimmedName)),
    [trimmedName],
  );
  const phone = phoneState(contactPhone);
  const yapeState = phoneState(yape);
  const plinState = phoneState(plin);

  const canContinueStep1 = nameLengthOk && slugValidation.ok && phone !== 'invalid';
  const missingStep1: string[] = [];
  if (!nameLengthOk) missingStep1.push(t('onboarding.missingName'));
  else if (!slugValidation.ok) missingStep1.push(t('onboarding.missingSlug'));
  if (phone === 'invalid') missingStep1.push(t('onboarding.missingPhone'));

  const paymentsInvalid = yapeState === 'invalid' || plinState === 'invalid';
  const canSubmit = canContinueStep1 && !paymentsInvalid && !submitting;

  const slugMessage = slugValidation.ok
    ? null
    : slugValidation.code === 'slug_too_short'
      ? t('onboarding.slugTooShort')
      : slugValidation.code === 'slug_reserved'
        ? t('onboarding.slugReserved')
        : t('onboarding.slugInvalid');

  function goToLocation() {
    markTouched('name');
    markTouched('phone');
    if (!canContinueStep1) {
      if (!nameLengthOk || !slugValidation.ok) {
        document.getElementById('store-name')?.focus();
      } else {
        document.getElementById('store-phone')?.focus();
      }
      return;
    }
    setStep(2);
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    markTouched('name');
    markTouched('phone');
    markTouched('yape');
    markTouched('plin');
    if (!canSubmit) {
      setStep(1);
      toast.error(t('onboarding.fixFields'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/merchant/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          slug: slugValidation.ok ? slugValidation.slug : normalizeStoreSlug(trimmedName),
          category: category.trim() || null,
          description: description.trim() || null,
          location: location ?? undefined,
          contactPhone: digits(contactPhone) || null,
          payments: {
            yape: digits(yape) || null,
            plin: digits(plin) || null,
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
    <form onSubmit={submit} noValidate className="mt-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
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

          <div className="text-sm text-secondary sm:col-span-2">
            <label htmlFor="store-name" className="font-medium">
              {t('onboarding.businessName')} <span aria-hidden="true">*</span>
            </label>
            <input
              id="store-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                markTouched('name');
              }}
              onBlur={() => markTouched('name')}
              maxLength={80}
              required
              autoFocus
              autoComplete="organization"
              enterKeyHint="next"
              placeholder={t('onboarding.namePlaceholder')}
              aria-invalid={touched.name && !nameLengthOk}
              aria-describedby="store-name-help store-name-slug"
              className={`mt-1 h-12 w-full rounded-xl border bg-background px-3 text-base text-primary ${
                touched.name && !nameLengthOk ? 'border-destructive' : 'border-border-strong'
              }`}
            />
            <p
              id="store-name-help"
              className={`mt-1 text-xs ${
                touched.name && !nameLengthOk ? 'text-destructive' : 'text-tertiary'
              }`}
            >
              {touched.name && !nameLengthOk ? t('onboarding.nameInvalid') : t('onboarding.nameRules')}
            </p>
            {trimmedName.length >= 2 && (
              <p id="store-name-slug" className="mt-1 text-xs text-tertiary">
                {slugMessage
                  ? slugMessage
                  : t('onboarding.slugAuto', { slug: slugValidation.ok ? slugValidation.slug : '' })}
              </p>
            )}
          </div>

          <div className="text-sm text-secondary">
            <label htmlFor="store-category" className="font-medium">
              {t('onboarding.category')}{' '}
              <span className="text-xs text-muted">({t('common.optional')})</span>
            </label>
            <input
              id="store-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              list="merchant-categories"
              maxLength={60}
              autoComplete="off"
              placeholder={t('onboarding.categoryPlaceholder')}
              aria-describedby="store-category-help"
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
            <p id="store-category-help" className="mt-1 text-xs text-tertiary">
              {t('onboarding.categoryRules')}
            </p>
          </div>

          <div className="text-sm text-secondary">
            <label htmlFor="store-phone" className="font-medium">
              {t('onboarding.phone')}{' '}
              <span className="text-xs text-muted">({t('common.optional')})</span>
            </label>
            <input
              id="store-phone"
              value={contactPhone}
              onChange={(event) => {
                setContactPhone(formatPeruPhone(event.target.value));
                markTouched('phone');
              }}
              onBlur={() => markTouched('phone')}
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              enterKeyHint="next"
              maxLength={11}
              placeholder="987 654 321"
              aria-invalid={touched.phone && phone === 'invalid'}
              aria-describedby="store-phone-help"
              className={`mt-1 h-12 w-full rounded-xl border bg-background px-3 text-base text-primary ${
                touched.phone && phone === 'invalid' ? 'border-destructive' : 'border-border-strong'
              }`}
            />
            <p
              id="store-phone-help"
              className={`mt-1 text-xs ${
                touched.phone && phone === 'invalid' ? 'text-destructive' : 'text-tertiary'
              }`}
            >
              {touched.phone && phone === 'invalid' ? t('onboarding.phoneInvalid') : t('onboarding.phoneHint')}
            </p>
          </div>

          <div className="text-sm text-secondary sm:col-span-2">
            <label htmlFor="store-description" className="font-medium">
              {t('onboarding.description')}{' '}
              <span className="text-xs text-muted">({t('common.optional')})</span>
            </label>
            <textarea
              id="store-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={400}
              rows={2}
              placeholder={t('onboarding.descriptionPlaceholder')}
              aria-describedby="store-description-count"
              className="mt-1 w-full rounded-xl border border-border-strong bg-background px-3 py-2 text-base text-primary"
            />
            <p id="store-description-count" className="mt-1 text-right text-xs text-tertiary">
              {t('onboarding.charCount', { count: description.length, max: 400 })}
            </p>
          </div>

          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={goToLocation}
              aria-describedby={missingStep1.length > 0 ? 'store-step1-missing' : undefined}
              className="h-12 w-full rounded-xl bg-brand px-6 text-base font-semibold text-background sm:w-auto"
            >
              {t('onboarding.continue')} →
            </button>
            {missingStep1.length > 0 && (
              <ul id="store-step1-missing" className="mt-2 space-y-0.5 text-xs text-tertiary">
                {missingStep1.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            )}
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
            <div className="text-sm text-secondary">
              <label htmlFor="store-yape" className="font-medium">
                {t('merchant.paymentsYape')}
              </label>
              <input
                id="store-yape"
                value={yape}
                onChange={(event) => {
                  setYape(formatPeruPhone(event.target.value));
                  markTouched('yape');
                }}
                onBlur={() => markTouched('yape')}
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                maxLength={11}
                placeholder="987 654 321"
                aria-invalid={touched.yape && yapeState === 'invalid'}
                aria-describedby="store-yape-help"
                className={`mt-1 h-12 w-full rounded-xl border bg-background px-3 text-base ${
                  touched.yape && yapeState === 'invalid' ? 'border-destructive' : 'border-border-strong'
                }`}
              />
              <p
                id="store-yape-help"
                className={`mt-1 text-xs ${
                  touched.yape && yapeState === 'invalid' ? 'text-destructive' : 'text-tertiary'
                }`}
              >
                {touched.yape && yapeState === 'invalid'
                  ? t('onboarding.paymentPhoneInvalid')
                  : t('onboarding.paymentPhoneRules')}
              </p>
            </div>

            <div className="text-sm text-secondary">
              <label htmlFor="store-plin" className="font-medium">
                {t('merchant.paymentsPlin')}
              </label>
              <input
                id="store-plin"
                value={plin}
                onChange={(event) => {
                  setPlin(formatPeruPhone(event.target.value));
                  markTouched('plin');
                }}
                onBlur={() => markTouched('plin')}
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                maxLength={11}
                placeholder="987 654 321"
                aria-invalid={touched.plin && plinState === 'invalid'}
                aria-describedby="store-plin-help"
                className={`mt-1 h-12 w-full rounded-xl border bg-background px-3 text-base ${
                  touched.plin && plinState === 'invalid' ? 'border-destructive' : 'border-border-strong'
                }`}
              />
              <p
                id="store-plin-help"
                className={`mt-1 text-xs ${
                  touched.plin && plinState === 'invalid' ? 'text-destructive' : 'text-tertiary'
                }`}
              >
                {touched.plin && plinState === 'invalid'
                  ? t('onboarding.paymentPhoneInvalid')
                  : t('onboarding.paymentPhoneRules')}
              </p>
            </div>

            <div className="text-sm text-secondary">
              <label htmlFor="store-bank" className="font-medium">
                {t('merchant.paymentsBank')}
              </label>
              <input
                id="store-bank"
                value={bankAccount}
                onChange={(event) => setBankAccount(event.target.value)}
                maxLength={60}
                autoComplete="off"
                placeholder="BCP · 193-1234567-0-12"
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base"
              />
            </div>

            <div className="text-sm text-secondary">
              <label htmlFor="store-holder" className="font-medium">
                {t('merchant.paymentsHolder')}
              </label>
              <input
                id="store-holder"
                value={holder}
                onChange={(event) => setHolder(event.target.value)}
                maxLength={80}
                autoComplete="name"
                placeholder={t('merchant.paymentsHolderPlaceholder')}
                className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-base"
              />
            </div>

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
              aria-describedby={!canSubmit ? 'store-submit-missing' : undefined}
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
          <p id="store-submit-missing" className="mt-2 text-xs text-tertiary">
            {paymentsInvalid ? t('onboarding.missingPayment') : t('onboarding.paymentsLater')}
          </p>
        </div>
      )}
    </form>
  );
}
