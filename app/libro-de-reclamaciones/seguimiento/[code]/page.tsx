import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  businessConfig,
  businessValue,
  isLegalReadyForLaunch,
  legalContactEmail,
} from '@/config/business';
import {
  isComplaintOverdue,
  isValidPublicCode,
  type ComplaintKind,
  type ComplaintStatus,
} from '@/lib/complaints';
import { getComplaintByPublicCode } from '@/lib/complaints.server';
import { formatMoney } from '@/lib/format';
import { getLocale, getTranslator } from '@/lib/i18n/server';
import type { MessageKey } from '@/lib/i18n/dictionaries';
import { PrintButton } from './PrintButton';

interface TrackingPageProps {
  params: Promise<{ code: string }>;
}

const STATUS_KEYS: Record<ComplaintStatus, MessageKey> = {
  received: 'complaints.tracking.status_received',
  in_review: 'complaints.tracking.status_in_review',
  answered: 'complaints.tracking.status_answered',
};

const KIND_KEYS: Record<ComplaintKind, MessageKey> = {
  reclamo: 'complaints.kindReclamo',
  queja: 'complaints.kindQueja',
};

function formatDateTime(value: string, locale: 'es' | 'en'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PE', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(date);
}

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslator();
  return {
    title: `${t('complaints.tracking.metaTitle')} | ${businessConfig.name}`,
    // La constancia es personal: nunca se indexa ni se comparte.
    robots: { index: false, follow: false, nocache: true },
    alternates: { canonical: `${businessConfig.siteUrl}/libro-de-reclamaciones` },
  };
}

export default async function ComplaintTrackingPage({ params }: TrackingPageProps) {
  const { code } = await params;
  const { t } = await getTranslator();
  const locale = await getLocale();

  // Código mal formado y código inexistente responden lo mismo: no se enumera.
  if (!isValidPublicCode(code)) notFound();

  const complaint = await getComplaintByPublicCode(code);
  if (!complaint) notFound();

  const legalReady = isLegalReadyForLaunch();
  const overdue = isComplaintOverdue(complaint.status, complaint.dueAt);
  const number = complaint.complaintNumber;

  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <nav
        aria-label={t('complaints.breadcrumb')}
        className="mb-6 text-sm text-tertiary print:hidden"
      >
        <Link href="/" className="hover:text-primary">
          {t('complaints.home')}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href="/libro-de-reclamaciones" className="hover:text-primary">
          {t('complaints.metaTitle')}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-secondary">{number}</span>
      </nav>

      <header>
        <p className="text-xs uppercase tracking-wide text-tertiary">
          {t('complaints.tracking.heading')}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
          {t('complaints.tracking.number')} {number}
        </h1>
        <p className="mt-2 text-sm text-secondary">
          {t(KIND_KEYS[complaint.kind])} · {t(STATUS_KEYS[complaint.status])}
        </p>
      </header>

      {!legalReady && (
        <div
          role="note"
          className="mt-6 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning"
        >
          <p className="font-medium">{t('complaints.tracking.draftTitle')}</p>
          <p className="mt-1">
            {t('complaints.tracking.draftBody', {
              legalName: businessValue('legalName'),
              ruc: businessValue('ruc'),
              address: businessValue('address'),
            })}
          </p>
        </div>
      )}

      {overdue && (
        <div
          role="status"
          className="mt-6 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning"
        >
          {t('complaints.tracking.overdue')}
        </div>
      )}

      <section aria-labelledby="complaint-receipt" className="surface-card mt-8 p-5 sm:p-7">
        <h2 id="complaint-receipt" className="text-sm font-medium uppercase tracking-wide text-tertiary">
          {t('complaints.providerTitle')}
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-tertiary">{t('complaints.providerLegalName')}</dt>
            <dd>{businessValue('legalName')}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.providerRuc')}</dt>
            <dd>{businessValue('ruc')}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.providerAddress')}</dt>
            <dd>{businessValue('address')}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.providerJurisdiction')}</dt>
            <dd>{businessValue('jurisdiction')}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-tertiary">{t('complaints.providerContact')}</dt>
            <dd>{legalContactEmail()}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="complaint-data" className="surface-card mt-4 p-5 sm:p-7">
        <h2 id="complaint-data" className="text-sm font-medium uppercase tracking-wide text-tertiary">
          {t('complaints.tracking.heading')}
        </h2>
        <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-tertiary">{t('complaints.tracking.submittedAt')}</dt>
            <dd>{formatDateTime(complaint.submittedAt, locale)}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.tracking.dueAt')}</dt>
            <dd>{formatDateTime(complaint.dueAt, locale)}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.tracking.kind')}</dt>
            <dd>{t(KIND_KEYS[complaint.kind])}</dd>
          </div>
          <div>
            <dt className="text-tertiary">{t('complaints.tracking.status')}</dt>
            <dd>{t(STATUS_KEYS[complaint.status])}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-tertiary">{t('complaints.tracking.relatedItem')}</dt>
            <dd>{complaint.relatedItem}</dd>
          </div>
          {complaint.amountCents !== null && (
            <div>
              <dt className="text-tertiary">{t('complaints.tracking.amount')}</dt>
              <dd>{formatMoney(complaint.amountCents, complaint.currency, locale)}</dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-tertiary">{t('complaints.tracking.detail')}</dt>
            <dd className="whitespace-pre-line">{complaint.detail}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-tertiary">{t('complaints.tracking.request')}</dt>
            <dd className="whitespace-pre-line">{complaint.consumerRequest}</dd>
          </div>
        </dl>
      </section>

      {complaint.responseText && (
        <section aria-labelledby="complaint-response" className="surface-card mt-4 p-5 sm:p-7">
          <h2
            id="complaint-response"
            className="text-sm font-medium uppercase tracking-wide text-tertiary"
          >
            {t('complaints.tracking.response')}
          </h2>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-secondary">
            {complaint.responseText}
          </p>
          {complaint.respondedAt && (
            <p className="mt-3 text-xs text-tertiary">
              {t('complaints.tracking.respondedAt')}:{' '}
              {formatDateTime(complaint.respondedAt, locale)}
            </p>
          )}
          {complaint.providerActions && complaint.providerActions !== complaint.responseText && (
            <div className="mt-4">
              <h3 className="text-xs uppercase tracking-wide text-tertiary">
                {t('complaints.tracking.providerActions')}
              </h3>
              <p className="mt-1 whitespace-pre-line text-sm text-secondary">
                {complaint.providerActions}
              </p>
            </div>
          )}
        </section>
      )}

      <p className="mt-4 text-xs leading-relaxed text-tertiary">
        {t('complaints.tracking.printNote')}
      </p>

      <div className="mt-6 flex flex-col gap-3 print:hidden sm:flex-row sm:items-center">
        <PrintButton label={t('complaints.tracking.print')} />
        <Link href="/libro-de-reclamaciones" className="btn-secondary text-center">
          {t('complaints.tracking.newComplaint')}
        </Link>
        <Link
          href="/libro-de-reclamaciones"
          className="text-sm text-tertiary underline underline-offset-4 hover:text-primary"
        >
          {t('complaints.tracking.back')}
        </Link>
      </div>
    </main>
  );
}
