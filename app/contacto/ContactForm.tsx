'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/components/i18n/I18nProvider';
import { CONTACT_LIMITS } from '@/lib/contact';

type FieldErrors = Partial<Record<'name' | 'email' | 'phone' | 'message' | 'consent', string>>;

interface SuccessPayload {
  ok: true;
  delivery: string;
  message?: string;
}

interface ErrorPayload {
  ok: false;
  code?: string;
  error?: string;
  errors?: FieldErrors;
}

const EMPTY_FORM = {
  name: '',
  email: '',
  phone: '',
  message: '',
  consent: false,
  company: '', // honeypot
};

export function ContactForm() {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = <Key extends keyof typeof EMPTY_FORM>(key: Key, value: (typeof EMPTY_FORM)[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key !== 'company') {
      setErrors((current) => ({ ...current, [key]: undefined }));
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setSuccess(null);
    setErrors({});
    setSubmitting(true);

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = (await response.json().catch(() => null)) as SuccessPayload | ErrorPayload | null;

      if (!response.ok || !payload || payload.ok !== true) {
        const failure = (payload ?? {}) as ErrorPayload;
        setErrors(failure.errors ?? {});
        setSubmitError(
          failure.error ??
            (failure.code === 'rate_limited'
              ? t('contact.rateLimited')
              : t('contact.sendFailed')),
        );
        return;
      }

      setSuccess(payload.message ?? t('contact.sent'));
      setForm(EMPTY_FORM);
    } catch {
      setSubmitError(t('contact.networkError'));
    } finally {
      setSubmitting(false);
    }
  };

  const messageLength = form.message.trim().length;

  return (
    <form onSubmit={handleSubmit} noValidate className="surface-card p-5 sm:p-7">
      <h2 className="text-lg font-medium">{t('contact.formTitle')}</h2>
      <p className="mt-1 text-sm text-tertiary">{t('contact.formSubtitle')}</p>

      {success && (
        <div
          role="status"
          className="mt-5 rounded-2xl border border-success/40 bg-success/10 p-4 text-sm text-success"
        >
          {success}
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="mt-5 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {submitError}{' '}
          <Link href="/contacto" className="underline underline-offset-4">
            {t('contact.retry')}
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="contact-name" className="field-label">
            {t('contact.name')} <span className="text-destructive">*</span>
          </label>
          <input
            id="contact-name"
            name="name"
            autoComplete="name"
            required
            minLength={CONTACT_LIMITS.nameMin}
            maxLength={CONTACT_LIMITS.nameMax}
            value={form.name}
            onChange={(event) => update('name', event.target.value)}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? 'contact-name-error' : undefined}
            className="field-input"
            placeholder={t('contact.namePlaceholder')}
          />
          {errors.name && (
            <p id="contact-name-error" className="mt-1 text-xs text-destructive">
              {errors.name}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="contact-email" className="field-label">
            {t('contact.emailLabel')} <span className="text-destructive">*</span>
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={CONTACT_LIMITS.emailMax}
            value={form.email}
            onChange={(event) => update('email', event.target.value)}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'contact-email-error' : undefined}
            className="field-input"
            placeholder={t('contact.emailPlaceholder')}
          />
          {errors.email && (
            <p id="contact-email-error" className="mt-1 text-xs text-destructive">
              {errors.email}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="contact-phone" className="field-label">
          {t('contact.phone')} <span className="text-tertiary">{t('contact.optional')}</span>
        </label>
        <input
          id="contact-phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          maxLength={CONTACT_LIMITS.phoneMax}
          value={form.phone}
          onChange={(event) => update('phone', event.target.value)}
          aria-invalid={Boolean(errors.phone)}
          aria-describedby={errors.phone ? 'contact-phone-error' : undefined}
          className="field-input"
          placeholder="+51 999 999 999"
        />
        {errors.phone && (
          <p id="contact-phone-error" className="mt-1 text-xs text-destructive">
            {errors.phone}
          </p>
        )}
      </div>

      <div className="mt-4">
        <label htmlFor="contact-message" className="field-label">
          {t('contact.message')} <span className="text-destructive">*</span>
        </label>
        <textarea
          id="contact-message"
          name="message"
          required
          rows={6}
          minLength={CONTACT_LIMITS.messageMin}
          maxLength={CONTACT_LIMITS.messageMax}
          value={form.message}
          onChange={(event) => update('message', event.target.value)}
          aria-invalid={Boolean(errors.message)}
          aria-describedby={`contact-message-help${errors.message ? ' contact-message-error' : ''}`}
          className="field-input resize-y"
          placeholder={t('contact.messagePlaceholder')}
        />
        <div className="mt-1 flex items-start justify-between gap-3">
          <p id="contact-message-help" className="text-xs text-tertiary">
            {t('contact.privacyNote')}
          </p>
          <span className="shrink-0 text-xs text-muted">
            {messageLength}/{CONTACT_LIMITS.messageMax}
          </span>
        </div>
        {errors.message && (
          <p id="contact-message-error" className="mt-1 text-xs text-destructive">
            {errors.message}
          </p>
        )}
      </div>

      {/* Honeypot: invisible para personas, tentador para bots. */}
      <div aria-hidden="true" className="pointer-events-none absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="contact-company">{t('contact.company')}</label>
        <input
          id="contact-company"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          value={form.company}
          onChange={(event) => update('company', event.target.value)}
        />
      </div>

      <div className="mt-5 flex items-start gap-3">
        <input
          id="contact-consent"
          name="consent"
          type="checkbox"
          required
          checked={form.consent}
          onChange={(event) => update('consent', event.target.checked)}
          aria-invalid={Boolean(errors.consent)}
          aria-describedby={errors.consent ? 'contact-consent-error' : undefined}
          className="mt-1 h-4 w-4 rounded border-border-strong"
        />
        <div>
          <label htmlFor="contact-consent" className="text-sm text-secondary">
            {t('contact.formConsentPrefix')}{' '}
            <Link
              href="/legal/privacidad"
              className="underline underline-offset-4 hover:text-primary"
            >
              {t('contact.privacyLink')}
            </Link>{' '}
            {t('contact.formConsentSuffix')}
          </label>
          {errors.consent && (
            <p id="contact-consent-error" className="mt-1 text-xs text-destructive">
              {errors.consent}
            </p>
          )}
        </div>
      </div>

      <button type="submit" disabled={submitting} className="btn-primary mt-6 w-full sm:w-auto">
        {submitting ? t('contact.sending') : t('contact.send')}
      </button>
    </form>
  );
}
