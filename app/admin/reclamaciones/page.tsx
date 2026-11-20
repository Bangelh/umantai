'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { ComplaintAdminView } from '@/lib/complaints.server';
import { AdminNav } from '../components/AdminNav';

interface HolidayCalendarInfo {
  version: string;
  configuredYears: number[];
}

interface ListPayload {
  ok?: boolean;
  complaints?: ComplaintAdminView[];
  calendar?: HolidayCalendarInfo;
  error?: string;
}

interface DetailPayload {
  ok?: boolean;
  complaint?: ComplaintAdminView;
  error?: string;
}

interface AnswerPayload {
  ok?: boolean;
  complaint?: ComplaintAdminView;
  emailStatus?: string;
  error?: string;
  code?: string;
}

const ALL = '';
const STATUSES = ['received', 'in_review', 'answered'] as const;
const KINDS = ['reclamo', 'queja'] as const;

const STATUS_KEYS = {
  received: 'adminComplaints.status_received',
  in_review: 'adminComplaints.status_in_review',
  answered: 'adminComplaints.status_answered',
} as const;

const KIND_KEYS = {
  reclamo: 'adminComplaints.kind_reclamo',
  queja: 'adminComplaints.kind_queja',
} as const;

function dueState(complaint: ComplaintAdminView): 'overdue' | 'soon' | null {
  if (complaint.status === 'answered') return null;
  const due = new Date(complaint.dueAt).getTime();
  if (Number.isNaN(due)) return null;
  const now = Date.now();
  if (due < now) return 'overdue';
  if (due - now <= 3 * 24 * 60 * 60 * 1000) return 'soon';
  return null;
}

function dueYear(complaint: ComplaintAdminView): number | null {
  const year = new Date(complaint.dueAt).getUTCFullYear();
  return Number.isInteger(year) ? year : null;
}

function missingCalendarYears(
  complaints: ComplaintAdminView[],
  calendar: HolidayCalendarInfo | null,
): number[] {
  if (!calendar) return [];
  const configured = new Set(calendar.configuredYears);
  const missing = new Set<number>();
  for (const complaint of complaints) {
    const year = dueYear(complaint);
    if (year !== null && !configured.has(year)) missing.add(year);
  }
  return [...missing].sort((a, b) => a - b);
}

/**
 * /admin/reclamaciones — Libro de Reclamaciones (Platform Admin).
 *
 * Solo sesión de Platform Admin (cookie firmada). La API exige esa misma sesión
 * y no acepta el token compartido porque muestra DNI, teléfonos y correos.
 *
 * No hay botón de borrado: las hojas se conservan como evidencia.
 */
export default function AdminComplaintsPage() {
  const { t, locale } = useI18n();
  const admin = usePlatformAdminSession();

  const [status, setStatus] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [complaints, setComplaints] = useState<ComplaintAdminView[]>([]);
  const [calendar, setCalendar] = useState<HolidayCalendarInfo | null>(null);
  const [selected, setSelected] = useState<ComplaintAdminView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [responseText, setResponseText] = useState('');
  const [providerActions, setProviderActions] = useState('');
  const [saving, setSaving] = useState(false);

  /**
   * `overrides` permite aplicar un cambio en el mismo gesto (por ejemplo,
   * limpiar filtros y recargar) sin esperar a que React propague el estado:
   * el usuario no tiene que pulsar dos botones para ver la lista limpia.
   */
  const load = useCallback(
    async (overrides?: { status?: string; kind?: string; from?: string; to?: string }) => {
    const nextStatus = overrides?.status ?? status;
    const nextKind = overrides?.kind ?? kind;
    const nextFrom = overrides?.from ?? from;
    const nextTo = overrides?.to ?? to;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (nextStatus) params.set('status', nextStatus);
      if (nextKind) params.set('kind', nextKind);
      if (nextFrom) params.set('from', nextFrom);
      if (nextTo) params.set('to', nextTo);

      const response = await fetch(`/api/admin/complaints?${params.toString()}`, withAdminAuth());
      const payload = (await response.json().catch(() => null)) as ListPayload | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? t('adminComplaints.error'));
      }
      setComplaints(payload.complaints ?? []);
      setCalendar(payload.calendar ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminComplaints.error'));
    } finally {
      setLoading(false);
    }
    },
    [from, kind, status, t, to],
  );

  useEffect(() => {
    if (admin.status !== 'authenticated') return;
    let cancelled = false;
    void fetch('/api/admin/complaints?limit=100', withAdminAuth())
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as ListPayload | null;
        if (cancelled) return;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? t('adminComplaints.error'));
        }
        setComplaints(payload.complaints ?? []);
        setCalendar(payload.calendar ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('adminComplaints.error'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [admin.status, t]);

  const detailRef = useRef<HTMLElement | null>(null);

  const openComplaint = async (id: string) => {
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/complaints/${id}`, withAdminAuth());
      const payload = (await response.json().catch(() => null)) as DetailPayload | null;
      if (!response.ok || !payload?.ok || !payload.complaint) {
        throw new Error(payload?.error ?? t('adminComplaints.error'));
      }
      setSelected(payload.complaint);
      setResponseText(payload.complaint.responseText ?? '');
      setProviderActions(payload.complaint.providerActions ?? '');
      // El detalle se abre al final de la página: llevamos el foco visual ahí
      // para que el clic no parezca que no hizo nada.
      window.setTimeout(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        detailRef.current?.scrollIntoView({
          block: 'start',
          behavior: reduced ? 'auto' : 'smooth',
        });
      }, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminComplaints.error'));
    }
  };

  const applyUpdate = (updated: ComplaintAdminView) => {
    setSelected(updated);
    setComplaints((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
  };

  const startReview = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/complaints/${selected.id}`,
        withAdminAuth({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start_review' }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as AnswerPayload | null;
      if (!response.ok || !payload?.ok || !payload.complaint) {
        throw new Error(payload?.error ?? t('adminComplaints.updateError'));
      }
      applyUpdate(payload.complaint);
      setNotice(t('adminComplaints.status_in_review'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminComplaints.updateError'));
    } finally {
      setSaving(false);
    }
  };

  const submitAnswer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!responseText.trim()) {
      setError(t('adminComplaints.responseRequired'));
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/admin/complaints/${selected.id}`,
        withAdminAuth({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'answer',
            responseText,
            providerActions: providerActions.trim() || null,
          }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as AnswerPayload | null;
      if (!response.ok || !payload?.ok || !payload.complaint) {
        throw new Error(payload?.error ?? t('adminComplaints.updateError'));
      }
      applyUpdate(payload.complaint);
      setNotice(
        payload.emailStatus === 'sent'
          ? t('adminComplaints.emailSent')
          : payload.emailStatus === 'failed'
            ? t('adminComplaints.emailFailed')
            : t('adminComplaints.emailOff'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminComplaints.updateError'));
    } finally {
      setSaving(false);
    }
  };

  const overdueCount = complaints.filter((complaint) => dueState(complaint) === 'overdue').length;
  const soonCount = complaints.filter((complaint) => dueState(complaint) === 'soon').length;
  const missingYears = missingCalendarYears(complaints, calendar);

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen
        title={t('adminComplaints.title')}
        status={admin.status}
        onActivate={admin.activate}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 text-primary sm:p-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('adminComplaints.title')}
            </h1>
            <p className="mt-1 text-sm text-tertiary">{t('adminComplaints.subtitle')}</p>
            <p className="mt-1 text-xs text-warning">{t('adminComplaints.deadlineNote')}</p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="h-11 rounded-xl border border-border-strong px-4 text-sm hover:bg-surface-raised disabled:opacity-50"
          >
            {loading ? t('adminComplaints.loading') : t('adminComplaints.refresh')}
          </button>
        </div>

        <div className="mt-4">
          <AdminNav />
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {[
            {
              label: t('adminComplaints.pending'),
              value: complaints.filter((complaint) => complaint.status !== 'answered').length,
              tone: 'text-primary',
              card: 'border-border bg-surface',
              edge: 'via-brand/30',
            },
            {
              label: t('adminComplaints.dueSoon'),
              value: soonCount,
              tone: 'text-warning',
              card: 'border-warning/40 bg-warning/5',
              edge: 'via-warning/40',
            },
            {
              label: t('adminComplaints.overdue'),
              value: overdueCount,
              tone: 'text-destructive',
              card: 'border-destructive/40 bg-destructive/5',
              edge: 'via-destructive/40',
            },
          ].map((item) => (
            <div
              key={item.label}
              className={`relative overflow-hidden rounded-2xl border p-4 ${item.card}`}
            >
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${item.edge}`}
              />
              <div className={`text-xs uppercase tracking-wide ${item.tone}`}>{item.label}</div>
              <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${item.tone}`}>
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {missingYears.length > 0 && (
          <div
            role="status"
            className="mt-4 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning"
          >
            {t('adminComplaints.calendarMissing')} {missingYears.join(', ')}.{' '}
            {t('adminComplaints.calendarMissingHelp')}
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            setLoading(true);
            void load().finally(() => setLoading(false));
          }}
          className="mt-6 grid gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
        >
          <label className="text-[13px] text-tertiary">
            <span className="mb-1 block">{t('adminComplaints.status')}</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-[15px] text-primary"
            >
              <option value={ALL}>{t('adminComplaints.all')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(STATUS_KEYS[value])}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[13px] text-tertiary">
            <span className="mb-1 block">{t('adminComplaints.kind')}</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-[15px] text-primary"
            >
              <option value={ALL}>{t('adminComplaints.all')}</option>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(KIND_KEYS[value])}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[13px] text-tertiary">
            <span className="mb-1 block">{t('adminComplaints.from')}</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-[15px] text-primary"
            />
          </label>

          <label className="text-[13px] text-tertiary">
            <span className="mb-1 block">{t('adminComplaints.to')}</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-[15px] text-primary"
            />
          </label>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary h-11 flex-1 px-3 text-sm" disabled={loading}>
              {t('adminComplaints.apply')}
            </button>
            <button
              type="button"
              onClick={() => {
                setStatus(ALL);
                setKind(ALL);
                setFrom('');
                setTo('');
                void load({ status: ALL, kind: ALL, from: '', to: '' });
              }}
              className="btn-secondary h-11 px-3 text-sm"
            >
              {t('adminComplaints.clear')}
            </button>
          </div>
        </form>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="mt-4 rounded-2xl border border-success/40 bg-success/10 p-4 text-sm text-success"
          >
            {notice}
          </div>
        )}

        {/* Móvil: tarjetas. La tabla de nueve columnas solo tiene sentido desde lg;
            por debajo obligaba a un scroll horizontal para leer una hoja. */}
        <ul className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface lg:hidden">
          {complaints.map((complaint) => {
            const due = dueState(complaint);
            const open = complaint.status === 'answered';
            return (
              <li key={complaint.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold tabular-nums">
                        {complaint.complaintNumber}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          open
                            ? 'border-border bg-surface-raised text-tertiary'
                            : 'border-warning/40 bg-warning/10 text-warning'
                        }`}
                      >
                        {t(STATUS_KEYS[complaint.status])}
                      </span>
                    </div>
                    <p className="mt-2 truncate text-[15px] font-medium">
                      {complaint.consumerName}
                    </p>
                    <p className="truncate text-xs text-tertiary">{complaint.consumerEmail}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openComplaint(complaint.id)}
                    aria-label={`${t('adminComplaints.open')}: ${complaint.complaintNumber}`}
                    className="min-h-11 shrink-0 rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised"
                  >
                    {t('adminComplaints.open')}
                  </button>
                </div>

                <p className="mt-3 line-clamp-2 text-sm text-secondary">
                  {complaint.relatedItem}
                </p>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-tertiary">
                  <span>{formatDateTime(complaint.submittedAt, locale)}</span>
                  <span
                    className={
                      due === 'overdue'
                        ? 'font-medium text-destructive'
                        : due === 'soon'
                          ? 'font-medium text-warning'
                          : ''
                    }
                  >
                    {t('adminComplaints.due')}: {formatDateTime(complaint.dueAt, locale)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        {!loading && complaints.length === 0 && (
          <p className="mt-6 rounded-2xl border border-border bg-surface px-4 py-8 text-center text-[15px] text-tertiary lg:hidden">
            {t('adminComplaints.empty')}
          </p>
        )}

        <div className="mt-6 hidden overflow-x-auto rounded-2xl border border-border lg:block">
          <table className="w-full min-w-[820px] text-[15px]">
            <thead className="border-b border-border bg-surface text-left text-[13px] uppercase tracking-wide text-tertiary">
              <tr>
                <th className="px-4 py-3">{t('adminComplaints.number')}</th>
                <th className="px-4 py-3">{t('adminComplaints.date')}</th>
                <th className="px-4 py-3">{t('adminComplaints.kind')}</th>
                <th className="px-4 py-3">{t('adminComplaints.consumer')}</th>
                <th className="px-4 py-3">{t('adminComplaints.item')}</th>
                <th className="px-4 py-3">{t('adminComplaints.assignee')}</th>
                <th className="px-4 py-3">{t('adminComplaints.due')}</th>
                <th className="px-4 py-3">{t('adminComplaints.status')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {complaints.map((complaint) => {
                const due = dueState(complaint);
                return (
                  <tr key={complaint.id} className="align-top transition-colors hover:bg-surface-raised/50">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[13px]">
                      {complaint.complaintNumber}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-tertiary">
                      {formatDateTime(complaint.submittedAt, locale)}
                    </td>
                    <td className="px-4 py-3">{t(KIND_KEYS[complaint.kind])}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{complaint.consumerName}</div>
                      <div className="text-[13px] text-tertiary">{complaint.consumerEmail}</div>
                    </td>
                    <td className="max-w-[16rem] px-4 py-3 text-[13px]">{complaint.relatedItem}</td>
                    <td className="max-w-[12rem] px-4 py-3 text-[13px]">
                      <div className="truncate" title={complaint.assignedTo}>
                        {complaint.assignedTo}
                      </div>
                    </td>
                    <td
                      className={`px-4 py-3 text-[13px] ${
                        due === 'overdue'
                          ? 'font-medium text-destructive'
                          : due === 'soon'
                            ? 'text-warning'
                            : 'text-tertiary'
                      }`}
                    >
                      {formatDateTime(complaint.dueAt, locale)}
                      {due === 'overdue' && (
                        <span className="mt-1 block text-xs font-medium uppercase tracking-wide">
                          {t('adminComplaints.overdue')}
                        </span>
                      )}
                      {due === 'soon' && (
                        <span className="mt-1 block text-xs font-medium uppercase tracking-wide">
                          {t('adminComplaints.dueSoon')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[13px]">
                      {t(STATUS_KEYS[complaint.status])}
                      {complaint.overdue && (
                        <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-destructive">
                          {t('adminComplaints.overdue')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void openComplaint(complaint.id)}
                        className="h-11 rounded-xl border border-border-strong px-4 text-sm hover:bg-surface-raised"
                      >
                        {t('adminComplaints.open')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!loading && complaints.length === 0 && (
            <p className="px-4 py-8 text-center text-[15px] text-tertiary">{t('adminComplaints.empty')}</p>
          )}
        </div>

        {selected && (
          <section
            ref={detailRef}
            aria-labelledby="complaint-detail-title"
            className="mt-8 scroll-mt-24 rounded-2xl border border-border bg-surface p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="complaint-detail-title" className="text-xl font-semibold">
                  {selected.complaintNumber} · {t(KIND_KEYS[selected.kind])}
                </h2>
                <p className="mt-1 text-[13px] text-tertiary">
                  {t('adminComplaints.date')}: {formatDateTime(selected.submittedAt, locale)} ·{' '}
                  {t('adminComplaints.due')}: {formatDateTime(selected.dueAt, locale)}
                </p>
                <p className="mt-1 text-xs text-tertiary">
                  {t('adminComplaints.assignee')}: {selected.assignedTo}
                  {selected.assignedAt
                    ? ` · ${t('adminComplaints.assignedAt')}: ${formatDateTime(selected.assignedAt, locale)}`
                    : ''}
                </p>
                <p className="mt-1 text-xs text-tertiary">
                  {t('adminComplaints.status')}: {t(STATUS_KEYS[selected.status])}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="h-11 rounded-xl border border-border-strong px-4 text-sm hover:bg-surface-raised"
              >
                {t('adminComplaints.close')}
              </button>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div className="space-y-3 text-[15px]">
                <h3 className="text-xs uppercase tracking-wide text-tertiary">
                  {t('adminComplaints.contact')}
                </h3>
                <dl className="space-y-2">
                  <div>
                    <dt className="text-[13px] text-tertiary">{t('adminComplaints.consumer')}</dt>
                    <dd>{selected.consumerName}</dd>
                  </div>
                  <div>
                    <dt className="text-[13px] text-tertiary">{t('adminComplaints.document')}</dt>
                    <dd className="font-mono">{selected.consumerDocument}</dd>
                  </div>
                  <div>
                    <dt className="text-[13px] text-tertiary">{t('adminComplaints.phone')}</dt>
                    <dd className="font-mono">{selected.consumerPhone}</dd>
                  </div>
                  <div>
                    <dt className="text-[13px] text-tertiary">{t('adminComplaints.email')}</dt>
                    <dd className="break-all">{selected.consumerEmail}</dd>
                  </div>
                  {selected.isMinor && (
                    <div>
                      <dt className="text-xs text-tertiary">
                        {t('adminComplaints.guardian')} ({t('adminComplaints.minor')})
                      </dt>
                      <dd>
                        {selected.guardianName}
                        {selected.guardianDocument && (
                          <span className="ml-2 font-mono text-xs text-tertiary">
                            {selected.guardianDocument}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="space-y-3 text-[15px]">
                <h3 className="text-xs uppercase tracking-wide text-tertiary">
                  {t('adminComplaints.item')}
                </h3>
                <p>{selected.relatedItem}</p>
                {selected.amountCents !== null && (
                  <p>
                    <span className="text-xs text-tertiary">{t('adminComplaints.amount')}: </span>
                    {formatMoney(selected.amountCents, selected.currency, locale)}
                  </p>
                )}
                <div>
                  <p className="text-[13px] text-tertiary">{t('complaints.detail')}</p>
                  <p className="mt-1 whitespace-pre-line">{selected.detail}</p>
                </div>
                <div>
                  <p className="text-[13px] text-tertiary">{t('complaints.request')}</p>
                  <p className="mt-1 whitespace-pre-line">{selected.consumerRequest}</p>
                </div>
              </div>
            </div>

            {selected.status !== 'answered' && (
              <div className="mt-6 flex flex-wrap gap-3">
                {selected.status === 'received' && (
                  <button
                    type="button"
                    onClick={() => void startReview()}
                    disabled={saving}
                    className="btn-secondary"
                  >
                    {t('adminComplaints.startReview')}
                  </button>
                )}
              </div>
            )}

            {selected.status === 'answered' ? (
              <div className="mt-6 rounded-2xl border border-border p-4">
                <h3 className="text-sm font-medium">{t('adminComplaints.historyTitle')}</h3>
                <dl className="mt-3 grid gap-2 text-[13px] text-tertiary sm:grid-cols-2">
                  <div>
                    <dt>{t('adminComplaints.answeredBy')}</dt>
                    <dd className="text-primary">
                      {selected.answeredBy ?? t('adminComplaints.assigneeUnknown')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('adminComplaints.answeredAt')}</dt>
                    <dd className="text-primary">
                      {selected.respondedAt
                        ? formatDateTime(selected.respondedAt, locale)
                        : t('adminComplaints.assigneeUnknown')}
                    </dd>
                  </div>
                </dl>
                <h4 className="mt-4 text-xs uppercase tracking-wide text-tertiary">
                  {t('adminComplaints.responseLabel')}
                </h4>
                <p className="mt-1 whitespace-pre-line text-[15px] text-secondary">
                  {selected.responseText}
                </p>
                {selected.providerActions && (
                  <>
                    <h4 className="mt-4 text-xs uppercase tracking-wide text-tertiary">
                      {t('adminComplaints.actionsHistory')}
                    </h4>
                    <p className="mt-1 whitespace-pre-line text-[15px] text-secondary">
                      {selected.providerActions}
                    </p>
                  </>
                )}
                <p className="mt-3 text-xs text-tertiary">{t('adminComplaints.answered')}</p>
              </div>
            ) : (
              <form onSubmit={submitAnswer} className="mt-6 space-y-4">
                <h3 className="text-sm font-medium">{t('adminComplaints.answerTitle')}</h3>
                <div>
                  <label htmlFor="complaint-response" className="field-label">
                    {t('adminComplaints.responseLabel')}{' '}
                    <span className="text-destructive">*</span>
                  </label>
                  <textarea
                    id="complaint-response"
                    rows={6}
                    maxLength={4000}
                    value={responseText}
                    onChange={(event) => setResponseText(event.target.value)}
                    className="field-input resize-y"
                  />
                </div>
                <div>
                  <label htmlFor="complaint-actions" className="field-label">
                    {t('adminComplaints.actionsLabel')}
                  </label>
                  <textarea
                    id="complaint-actions"
                    rows={3}
                    maxLength={2000}
                    value={providerActions}
                    onChange={(event) => setProviderActions(event.target.value)}
                    className="field-input resize-y"
                  />
                </div>
                <button type="submit" disabled={saving} className="btn-primary">
                  {saving ? t('adminComplaints.answering') : t('adminComplaints.answerSubmit')}
                </button>
              </form>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
