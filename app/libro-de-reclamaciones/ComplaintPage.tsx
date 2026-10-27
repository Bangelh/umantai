'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useI18n } from '@/components/i18n/I18nProvider';
import { LegalDemoNotice } from '@/components/legal/LegalDemoNotice';
import {
  COMPLAINT_LIMITS,
  isValidPublicCode,
  type ComplaintErrorCode,
  type ComplaintErrors,
  type ComplaintField,
  type ComplaintKind,
} from '@/lib/complaints';
import type { MessageKey } from '@/lib/i18n/dictionaries';
import type { PendingBusinessField } from '@/config/business';

interface ProviderData {
  name: string;
  legalName: string;
  ruc: string;
  address: string;
  jurisdiction: string;
  contact: string;
  whatsapp: string;
}

interface ComplaintPageProps {
  provider: ProviderData;
  legalReady: boolean;
  /** Datos del titular de DEMOSTRACIÓN (solo staging): exige el aviso visible. */
  demoData: boolean;
  pendingFields: PendingBusinessField[];
  pendingFieldNames: string[];
}

interface FormState {
  kind: ComplaintKind;
  consumerName: string;
  consumerDocument: string;
  consumerPhone: string;
  consumerEmail: string;
  isMinor: boolean;
  guardianName: string;
  guardianDocument: string;
  relatedItem: string;
  amount: string;
  detail: string;
  consumerRequest: string;
  consent: boolean;
  company: string;
}

interface CreatedPayload {
  ok: true;
  trackingPath: string;
  complaintNumber: string;
  dueAt: string;
  emailStatus: string;
}

interface ErrorPayload {
  ok: false;
  code?: string;
  errors?: ComplaintErrors;
}

const EMPTY_FORM: FormState = {
  kind: 'reclamo',
  consumerName: '',
  consumerDocument: '',
  consumerPhone: '',
  consumerEmail: '',
  isMinor: false,
  guardianName: '',
  guardianDocument: '',
  relatedItem: '',
  amount: '',
  detail: '',
  consumerRequest: '',
  consent: false,
  company: '',
};

const ERROR_KEYS: Record<ComplaintErrorCode, MessageKey> = {
  required: 'complaints.error.required',
  too_short: 'complaints.error.too_short',
  too_long: 'complaints.error.too_long',
  invalid: 'complaints.error.invalid',
  invalid_email: 'complaints.error.invalid_email',
  invalid_phone: 'complaints.error.invalid_phone',
  invalid_document: 'complaints.error.invalid_document',
  invalid_amount: 'complaints.error.invalid_amount',
  guardian_required: 'complaints.error.guardian_required',
};

const FIELD_LABEL_KEYS: Record<ComplaintField, MessageKey> = {
  kind: 'complaints.kind',
  consumerName: 'complaints.name',
  consumerDocument: 'complaints.document',
  consumerPhone: 'complaints.phone',
  consumerEmail: 'complaints.email',
  guardianName: 'complaints.guardianName',
  guardianDocument: 'complaints.guardianDocument',
  relatedItem: 'complaints.relatedItem',
  amountCents: 'complaints.amount',
  detail: 'complaints.detail',
  consumerRequest: 'complaints.request',
  consent: 'complaints.consentLabel',
};

const FIELD_INPUT_IDS: Record<ComplaintField, string> = {
  kind: 'complaint-kind-reclamo',
  consumerName: 'complaint-name',
  consumerDocument: 'complaint-document',
  consumerPhone: 'complaint-phone',
  consumerEmail: 'complaint-email',
  guardianName: 'complaint-guardian-name',
  guardianDocument: 'complaint-guardian-document',
  relatedItem: 'complaint-item',
  amountCents: 'complaint-amount',
  detail: 'complaint-detail',
  consumerRequest: 'complaint-request',
  consent: 'complaint-consent',
};

export function ComplaintPage({
  provider,
  legalReady,
  demoData,
  pendingFieldNames,
}: ComplaintPageProps) {
  const { t } = useI18n();
  const router = useRouter();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<ComplaintErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [trackingCode, setTrackingCode] = useState('');
  const [trackingError, setTrackingError] = useState<string | null>(null);

  const update = <Key extends keyof FormState>(key: Key, value: FormState[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key !== 'company') {
      setErrors((current) => ({ ...current, [key as ComplaintField]: undefined }));
    }
  };

  const fieldError = (field: ComplaintField) => {
    const code = errors[field];
    return code ? t(ERROR_KEYS[code]) : null;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setErrors({});
    setSubmitting(true);

    const { amount, ...rest } = form;
    const body = {
      ...rest,
      amountCents: amount.trim() ? amount.trim() : null,
    };

    try {
      const response = await fetch('/api/complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as CreatedPayload | ErrorPayload | null;

      if (!response.ok || !payload || payload.ok !== true) {
        const failure = (payload ?? {}) as ErrorPayload;
        setErrors(failure.errors ?? {});
        setSubmitError(
          failure.code === 'rate_limited'
            ? t('complaints.api.rateLimited')
            : failure.code === 'complaints_unavailable'
              ? t('complaints.api.unavailable')
              : t('complaints.api.generic'),
        );
        const firstField = failure.errors ? (Object.keys(failure.errors)[0] as ComplaintField) : null;
        if (firstField) {
          document.getElementById(FIELD_INPUT_IDS[firstField])?.focus();
        }
        return;
      }

      router.push(payload.trackingPath);
    } catch {
      setSubmitError(t('complaints.api.network'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTracking = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = trackingCode.trim();
    if (!isValidPublicCode(code)) {
      setTrackingError(t('complaints.trackingInvalid'));
      return;
    }
    setTrackingError(null);
    router.push(`/libro-de-reclamaciones/seguimiento/${encodeURIComponent(code)}`);
  };

  const errorFields = Object.keys(errors) as ComplaintField[];

  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <nav aria-label={t('complaints.breadcrumb')} className="mb-6 text-sm text-tertiary">
        <Link href="/" className="hover:text-primary">
          {t('complaints.home')}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{t('complaints.metaTitle')}</span>
      </nav>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {t('complaints.title')}
        </h1>
        <p className="mt-3 text-sm text-secondary sm:text-base">{t('complaints.intro')}</p>
        <p className="mt-2 text-sm text-tertiary">{t('complaints.legalBasis')}</p>
      </header>

      {demoData && <LegalDemoNotice />}

      {!legalReady && (
        <div
          role="note"
          className="mt-6 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning"
        >
          <p>{t('complaints.notReady')}</p>
          {pendingFieldNames.length > 0 && (
            <p className="mt-2">
              {t('complaints.pendingFields', { fields: pendingFieldNames.join(', ') })}
            </p>
          )}
        </div>
      )}

      <section aria-labelledby="complaints-provider" className="surface-card mt-8 p-5 sm:p-6">
        <h2 id="complaints-provider" className="text-sm font-medium uppercase tracking-wide text-tertiary">
          {t('complaints.providerTitle')}
        </h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-tertiary">{t('complaints.providerLegalName')}</dt>
            <dd className="text-primary">{provider.legalName}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.providerRuc')}</dt>
            <dd className="text-primary">{provider.ruc}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.providerAddress')}</dt>
            <dd className="text-primary">{provider.address}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.providerJurisdiction')}</dt>
            <dd className="text-primary">{provider.jurisdiction}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-tertiary">{t('complaints.providerContact')}</dt>
            <dd className="text-primary">
              <a
                href={`mailto:${provider.contact}`}
                className="underline underline-offset-4 hover:text-primary"
              >
                {provider.contact}
              </a>
              {provider.whatsapp && <span className="text-tertiary"> · {provider.whatsapp}</span>}
            </dd>
          </div>
        </dl>
      </section>

      <form onSubmit={handleSubmit} noValidate className="surface-card mt-8 p-5 sm:p-7">
        <h2 className="text-lg font-medium">{t('complaints.formTitle')}</h2>
        <p className="mt-1 text-sm text-tertiary">{t('complaints.requiredNote')}</p>

        {submitError && (
          <div
            role="alert"
            className="mt-5 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            {submitError}
          </div>
        )}

        {errorFields.length > 0 && (
          <div
            role="alert"
            className="mt-5 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            <p className="font-medium">{t('complaints.errorSummary')}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {errorFields.map((field) => (
                <li key={field}>
                  {t(FIELD_LABEL_KEYS[field])}: {fieldError(field)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset className="mt-6">
          <legend className="field-label">
            {t('complaints.kind')} <span className="text-destructive">*</span>
          </legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(['reclamo', 'queja'] as const).map((kind) => (
              <label
                key={kind}
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-sm transition-colors ${
                  form.kind === kind ? 'border-brand bg-surface-raised' : 'border-border'
                }`}
              >
                <input
                  id={`complaint-kind-${kind}`}
                  type="radio"
                  name="kind"
                  value={kind}
                  checked={form.kind === kind}
                  onChange={() => update('kind', kind)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  <span className="block font-medium text-primary">
                    {t(kind === 'reclamo' ? 'complaints.kindReclamo' : 'complaints.kindQueja')}
                  </span>
                  <span className="mt-1 block text-xs text-tertiary">
                    {t(
                      kind === 'reclamo'
                        ? 'complaints.kindReclamoHint'
                        : 'complaints.kindQuejaHint',
                    )}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <h3 className="mt-8 text-sm font-medium uppercase tracking-wide text-tertiary">
          {t('complaints.consumerSection')}
        </h3>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="complaint-name" className="field-label">
              {t('complaints.name')} <span className="text-destructive">*</span>
            </label>
            <input
              id="complaint-name"
              name="consumerName"
              autoComplete="name"
              required
              maxLength={COMPLAINT_LIMITS.nameMax}
              value={form.consumerName}
              onChange={(event) => update('consumerName', event.target.value)}
              aria-invalid={Boolean(errors.consumerName)}
              aria-describedby={errors.consumerName ? 'complaint-name-error' : undefined}
              className="field-input"
              placeholder={t('complaints.namePlaceholder')}
            />
            {errors.consumerName && (
              <p id="complaint-name-error" className="mt-1 text-xs text-destructive">
                {fieldError('consumerName')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="complaint-document" className="field-label">
              {t('complaints.document')} <span className="text-destructive">*</span>
            </label>
            <input
              id="complaint-document"
              name="consumerDocument"
              autoComplete="off"
              required
              maxLength={COMPLAINT_LIMITS.documentMax}
              value={form.consumerDocument}
              onChange={(event) => update('consumerDocument', event.target.value)}
              aria-invalid={Boolean(errors.consumerDocument)}
              aria-describedby={`complaint-document-help${
                errors.consumerDocument ? ' complaint-document-error' : ''
              }`}
              className="field-input"
              placeholder="12345678"
            />
            <p id="complaint-document-help" className="mt-1 text-xs text-tertiary">
              {t('complaints.documentHint')}
            </p>
            {errors.consumerDocument && (
              <p id="complaint-document-error" className="mt-1 text-xs text-destructive">
                {fieldError('consumerDocument')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="complaint-phone" className="field-label">
              {t('complaints.phone')} <span className="text-destructive">*</span>
            </label>
            <input
              id="complaint-phone"
              name="consumerPhone"
              type="tel"
              autoComplete="tel"
              required
              maxLength={COMPLAINT_LIMITS.phoneMax}
              value={form.consumerPhone}
              onChange={(event) => update('consumerPhone', event.target.value)}
              aria-invalid={Boolean(errors.consumerPhone)}
              aria-describedby={errors.consumerPhone ? 'complaint-phone-error' : undefined}
              className="field-input"
              placeholder="+51 999 999 999"
            />
            {errors.consumerPhone && (
              <p id="complaint-phone-error" className="mt-1 text-xs text-destructive">
                {fieldError('consumerPhone')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="complaint-email" className="field-label">
              {t('complaints.email')} <span className="text-destructive">*</span>
            </label>
            <input
              id="complaint-email"
              name="consumerEmail"
              type="email"
              autoComplete="email"
              required
              maxLength={COMPLAINT_LIMITS.emailMax}
              value={form.consumerEmail}
              onChange={(event) => update('consumerEmail', event.target.value)}
              aria-invalid={Boolean(errors.consumerEmail)}
              aria-describedby={`complaint-email-help${
                errors.consumerEmail ? ' complaint-email-error' : ''
              }`}
              className="field-input"
              placeholder={t('contact.emailPlaceholder')}
            />
            <p id="complaint-email-help" className="mt-1 text-xs text-tertiary">
              {t('complaints.emailHint')}
            </p>
            {errors.consumerEmail && (
              <p id="complaint-email-error" className="mt-1 text-xs text-destructive">
                {fieldError('consumerEmail')}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3">
          <input
            id="complaint-minor"
            type="checkbox"
            checked={form.isMinor}
            onChange={(event) => update('isMinor', event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-border-strong"
          />
          <label htmlFor="complaint-minor" className="text-sm text-secondary">
            {t('complaints.minor')}
          </label>
        </div>

        {form.isMinor && (
          <fieldset className="mt-4 rounded-2xl border border-border p-4">
            <legend className="px-2 text-sm font-medium text-secondary">
              {t('complaints.guardianSection')}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="complaint-guardian-name" className="field-label">
                  {t('complaints.guardianName')} <span className="text-destructive">*</span>
                </label>
                <input
                  id="complaint-guardian-name"
                  autoComplete="name"
                  maxLength={COMPLAINT_LIMITS.nameMax}
                  value={form.guardianName}
                  onChange={(event) => update('guardianName', event.target.value)}
                  aria-invalid={Boolean(errors.guardianName)}
                  aria-describedby={errors.guardianName ? 'complaint-guardian-name-error' : undefined}
                  className="field-input"
                />
                {errors.guardianName && (
                  <p id="complaint-guardian-name-error" className="mt-1 text-xs text-destructive">
                    {fieldError('guardianName')}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="complaint-guardian-document" className="field-label">
                  {t('complaints.guardianDocument')} <span className="text-destructive">*</span>
                </label>
                <input
                  id="complaint-guardian-document"
                  autoComplete="off"
                  maxLength={COMPLAINT_LIMITS.documentMax}
                  value={form.guardianDocument}
                  onChange={(event) => update('guardianDocument', event.target.value)}
                  aria-invalid={Boolean(errors.guardianDocument)}
                  aria-describedby={
                    errors.guardianDocument ? 'complaint-guardian-document-error' : undefined
                  }
                  className="field-input"
                />
                {errors.guardianDocument && (
                  <p
                    id="complaint-guardian-document-error"
                    className="mt-1 text-xs text-destructive"
                  >
                    {fieldError('guardianDocument')}
                  </p>
                )}
              </div>
            </div>
          </fieldset>
        )}

        <h3 className="mt-8 text-sm font-medium uppercase tracking-wide text-tertiary">
          {t('complaints.complaintSection')}
        </h3>

        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div>
            <label htmlFor="complaint-item" className="field-label">
              {t('complaints.relatedItem')} <span className="text-destructive">*</span>
            </label>
            <input
              id="complaint-item"
              required
              maxLength={COMPLAINT_LIMITS.relatedItemMax}
              value={form.relatedItem}
              onChange={(event) => update('relatedItem', event.target.value)}
              aria-invalid={Boolean(errors.relatedItem)}
              aria-describedby={errors.relatedItem ? 'complaint-item-error' : undefined}
              className="field-input"
              placeholder={t('complaints.relatedItemPlaceholder')}
            />
            {errors.relatedItem && (
              <p id="complaint-item-error" className="mt-1 text-xs text-destructive">
                {fieldError('relatedItem')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="complaint-amount" className="field-label">
              {t('complaints.amount')}
            </label>
            <input
              id="complaint-amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              max={COMPLAINT_LIMITS.amountCentsMax / 100}
              value={form.amount}
              onChange={(event) => update('amount', event.target.value)}
              aria-invalid={Boolean(errors.amountCents)}
              aria-describedby={`complaint-amount-help${
                errors.amountCents ? ' complaint-amount-error' : ''
              }`}
              className="field-input"
              placeholder="0.00"
            />
            <p id="complaint-amount-help" className="mt-1 text-xs text-tertiary">
              {t('complaints.amountHint')}
            </p>
            {errors.amountCents && (
              <p id="complaint-amount-error" className="mt-1 text-xs text-destructive">
                {fieldError('amountCents')}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="complaint-detail" className="field-label">
            {t('complaints.detail')} <span className="text-destructive">*</span>
          </label>
          <textarea
            id="complaint-detail"
            required
            rows={5}
            maxLength={COMPLAINT_LIMITS.detailMax}
            value={form.detail}
            onChange={(event) => update('detail', event.target.value)}
            aria-invalid={Boolean(errors.detail)}
            aria-describedby={errors.detail ? 'complaint-detail-error' : undefined}
            className="field-input resize-y"
            placeholder={t('complaints.detailPlaceholder')}
          />
          {errors.detail && (
            <p id="complaint-detail-error" className="mt-1 text-xs text-destructive">
              {fieldError('detail')}
            </p>
          )}
        </div>

        <div className="mt-4">
          <label htmlFor="complaint-request" className="field-label">
            {t('complaints.request')} <span className="text-destructive">*</span>
          </label>
          <textarea
            id="complaint-request"
            required
            rows={3}
            maxLength={COMPLAINT_LIMITS.requestMax}
            value={form.consumerRequest}
            onChange={(event) => update('consumerRequest', event.target.value)}
            aria-invalid={Boolean(errors.consumerRequest)}
            aria-describedby={errors.consumerRequest ? 'complaint-request-error' : undefined}
            className="field-input resize-y"
            placeholder={t('complaints.requestPlaceholder')}
          />
          {errors.consumerRequest && (
            <p id="complaint-request-error" className="mt-1 text-xs text-destructive">
              {fieldError('consumerRequest')}
            </p>
          )}
        </div>

        {/* Honeypot: invisible para personas, tentador para bots. */}
        <div aria-hidden="true" className="pointer-events-none absolute left-[-9999px] h-0 w-0 overflow-hidden">
          <label htmlFor="complaint-company">Company</label>
          <input
            id="complaint-company"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            value={form.company}
            onChange={(event) => update('company', event.target.value)}
          />
        </div>

        <div className="mt-5 flex items-start gap-3">
          <input
            id="complaint-consent"
            type="checkbox"
            required
            checked={form.consent}
            onChange={(event) => update('consent', event.target.checked)}
            aria-invalid={Boolean(errors.consent)}
            aria-describedby={errors.consent ? 'complaint-consent-error' : undefined}
            className="mt-1 h-4 w-4 rounded border-border-strong"
          />
          <div>
            <label htmlFor="complaint-consent" className="text-sm text-secondary">
              {t('complaints.consentPrefix')}{' '}
              <Link
                href="/legal/privacidad"
                className="underline underline-offset-4 hover:text-primary"
              >
                {t('complaints.privacyLink')}
              </Link>{' '}
              {t('complaints.consentSuffix')}
            </label>
            {errors.consent && (
              <p id="complaint-consent-error" className="mt-1 text-xs text-destructive">
                {fieldError('consent')}
              </p>
            )}
          </div>
        </div>

        <button type="submit" disabled={submitting} className="btn-primary mt-6 w-full sm:w-auto">
          {submitting ? t('complaints.submitting') : t('complaints.submit')}
        </button>
      </form>

      <section aria-labelledby="complaints-tracking" className="surface-card mt-8 p-5 sm:p-6">
        <h2 id="complaints-tracking" className="text-lg font-medium">
          {t('complaints.trackingTitle')}
        </h2>
        <p className="mt-1 text-sm text-tertiary">{t('complaints.trackingBody')}</p>
        <form onSubmit={handleTracking} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="complaint-tracking-code" className="field-label">
              {t('complaints.trackingCode')}
            </label>
            <input
              id="complaint-tracking-code"
              value={trackingCode}
              onChange={(event) => {
                setTrackingCode(event.target.value);
                setTrackingError(null);
              }}
              aria-invalid={Boolean(trackingError)}
              aria-describedby={trackingError ? 'complaint-tracking-error' : undefined}
              className="field-input"
              autoComplete="off"
              spellCheck={false}
            />
            {trackingError && (
              <p id="complaint-tracking-error" className="mt-1 text-xs text-destructive">
                {trackingError}
              </p>
            )}
          </div>
          <button type="submit" className="btn-secondary">
            {t('complaints.trackingButton')}
          </button>
        </form>
      </section>
    </main>
  );
}
