'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  addDays,
  todayInTimeZone,
  type AnalyticsRangePreset,
  type AnalyticsSummary,
} from '@/lib/analytics';
import { formatDate, formatMoney } from '@/lib/format';
import { AdminNav } from '../components/AdminNav';
import { SalesChart } from './components/SalesChart';

type SummaryPayload = ({ ok: true } & AnalyticsSummary) | { ok: false; error?: string; code?: string };

const TONE_CLASS: Record<string, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-info/30 bg-info/10 text-info',
  muted: 'border-border bg-surface-raised text-tertiary',
};

export default function AnalyticsPage() {
  const { locale, t } = useI18n();
  const admin = usePlatformAdminSession();
  const presets: Array<{ value: AnalyticsRangePreset; label: string }> = [
    { value: 'today', label: t('analytics.today') },
    { value: '7d', label: t('analytics.last7') },
    { value: '30d', label: t('analytics.last30') },
    { value: 'custom', label: t('analytics.custom') },
  ];
  const shortDate = (value: string) =>
    formatDate(value, locale, { month: 'short', day: 'numeric' });

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preset, setPreset] = useState<AnalyticsRangePreset>('30d');
  // Defaults del rango personalizado. Se calculan con la zona de Lima, igual en
  // servidor y cliente (no se usa la zona del navegador).
  const [customFrom, setCustomFrom] = useState(() => addDays(todayInTimeZone(), -29));
  const [customTo, setCustomTo] = useState(() => todayInTimeZone());
  const [granularity, setGranularity] = useState<'daily' | 'weekly'>('daily');

  const requestSeq = useRef(0);

  const load = useCallback(
    async (options: {
      preset: AnalyticsRangePreset;
      from?: string;
      to?: string;
    }) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({ range: options.preset });
      if (options.preset === 'custom') {
        params.set('from', options.from ?? '');
        params.set('to', options.to ?? '');
      }

      try {
        const response = await fetch(
          `/api/admin/analytics/summary?${params.toString()}`,
          withAdminAuth(),
        );
        const payload = (await response.json().catch(() => null)) as SummaryPayload | null;

        if (seq !== requestSeq.current) return; // llegó tarde: la descarta

        if (!response.ok || !payload?.ok) {
          setSummary(null);
          setError(
            (payload && 'error' in payload && payload.error) ||
              'No se pudo cargar el resumen de ventas.',
          );
          return;
        }

        setSummary(payload);
      } catch {
        if (seq !== requestSeq.current) return;
        setError('Error de red al cargar analytics. Revisa tu conexión y reintenta.');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [],
  );

  // Con sesión de Platform Admin activa, carga el resumen una vez.
  useEffect(() => {
    if (admin.status === 'authenticated') void load({ preset: '30d' });
  }, [admin.status, load]);

  const customRangeInvalid =
    preset === 'custom' &&
    (!customFrom || !customTo || customFrom > customTo);

  const applyCustomRange = () => {
    if (customRangeInvalid) return;
    void load({ preset: 'custom', from: customFrom, to: customTo });
  };

  const points = useMemo(
    () => (summary ? (granularity === 'daily' ? summary.series.daily : summary.series.weekly) : []),
    [summary, granularity],
  );

  const hasOrders = (summary?.sales.allOrders ?? 0) > 0;
  const hasSales = (summary?.sales.orders ?? 0) > 0;

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen
        title={t('analytics.title')}
        status={admin.status}
        onActivate={admin.activate}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24 pt-6 text-primary sm:pb-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[3px] text-tertiary">{t('analytics.kicker')}</div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('analytics.title')}</h1>
          </div>
          <AdminNav />
        </div>

        <p className="mt-2 max-w-2xl text-sm text-secondary">
          {t('analytics.subtitlePrefix')}{' '}
          <span className="font-medium text-primary">{summary?.range.timeZone ?? 'America/Lima'}</span>.{' '}
          {t('analytics.subtitleSuffix')}
        </p>

        {/* Filtros */}
        <section aria-label={t('analytics.filtersAria')} className="mt-6 surface-card p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <span className="field-label" id="preset-label">
                {t('analytics.period')}
              </span>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="preset-label">
                {presets.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={preset === option.value}
                    onClick={() => {
                      setPreset(option.value);
                      if (option.value !== 'custom') {
                        void load({ preset: option.value });
                      }
                    }}
                    disabled={loading}
                    className={`rounded-full border px-4 py-2 text-sm transition-colors disabled:opacity-50 ${
                      preset === option.value
                        ? 'border-brand bg-brand font-medium text-background'
                        : 'border-border-strong text-secondary hover:bg-surface-raised hover:text-primary'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {preset === 'custom' && (
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="range-from" className="field-label">
                    {t('analytics.from')}
                  </label>
                  <input
                    id="range-from"
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(event) => setCustomFrom(event.target.value)}
                    className="field-input h-11 w-40"
                  />
                </div>
                <div>
                  <label htmlFor="range-to" className="field-label">
                    {t('analytics.to')}
                  </label>
                  <input
                    id="range-to"
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(event) => setCustomTo(event.target.value)}
                    className="field-input h-11 w-40"
                  />
                </div>
                <button
                  type="button"
                  onClick={applyCustomRange}
                  disabled={customRangeInvalid || loading}
                  className="btn-secondary h-11"
                >
                  Aplicar
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() =>
                void load({
                  preset,
                  from: customFrom,
                  to: customTo,
                })
              }
              disabled={loading || customRangeInvalid}
              className="btn-secondary h-10 self-start lg:self-auto"
            >
              {loading ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>

          {customRangeInvalid && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {t('analytics.customRangeError')}
            </p>
          )}

          {summary && (
            <p className="mt-3 text-xs text-tertiary">
              {t('analytics.rangeLine', {
                from: summary.range.from,
                to: summary.range.to,
                days: summary.range.days,
                prevFrom: summary.previous.from,
                prevTo: summary.previous.to,
              })}
            </p>
          )}
        </section>

        {error && (
          <div
            role="alert"
            className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void load({ preset, from: customFrom, to: customTo })}
              className="btn-secondary h-9 border-destructive/40 px-4 text-destructive"
            >
              {t('analytics.retry')}
            </button>
          </div>
        )}

        {/* Cargando (skeleton) */}
        {loading && !summary && (
          <div aria-busy="true" aria-live="polite" className="mt-6 space-y-5">
            <span className="sr-only">{t('analytics.loading')}</span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="surface-card h-28 animate-pulse bg-surface-raised/40" />
              ))}
            </div>
            <div className="surface-card h-80 animate-pulse bg-surface-raised/40" />
          </div>
        )}

        {summary && (
          <div aria-busy={loading} className={`mt-6 space-y-6 ${loading ? 'opacity-60' : ''}`}>
            {/* KPIs */}
            <section aria-label={t('analytics.kpisAria')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi
                label={t('analytics.revenue')}
                value={formatMoney(summary.sales.revenueCents, 'PEN', locale)}
                change={summary.change.revenuePct}
                hint={t('analytics.previous', {
                  value: formatMoney(summary.previous.revenueCents, 'PEN', locale),
                })}
              />
              <Kpi
                label={t('analytics.ordersSold')}
                value={String(summary.sales.orders)}
                change={summary.change.ordersPct}
                hint={t('analytics.ordersCreated', { count: summary.sales.allOrders })}
              />
              <Kpi
                label={t('analytics.averageTicket')}
                value={formatMoney(summary.sales.averageTicketCents, 'PEN', locale)}
                hint={t('analytics.previous', {
                  value: formatMoney(summary.previous.averageTicketCents, 'PEN', locale),
                })}
              />
              <Kpi
                label={t('analytics.unitsSold')}
                value={String(summary.sales.itemsSold)}
                hint={t('analytics.cancelledOrders', { count: summary.sales.cancelledOrders })}
              />
            </section>

            {!hasOrders && (
              <div className="surface-card p-8 text-center">
                <h2 className="text-lg font-medium">{t('analytics.noOrdersTitle')}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-secondary">
                  {t('analytics.noOrdersBody', {
                    from: summary.range.from,
                    to: summary.range.to,
                  })}
                </p>
              </div>
            )}

            {hasOrders && !hasSales && (
              <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
                {t('analytics.pendingSales', { count: summary.sales.allOrders })}
              </div>
            )}

            {/* Gráfico */}
            <section aria-label={t('analytics.salesTrend')}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="sr-only">{t('analytics.salesTrend')}</h2>
                <div className="flex gap-2" role="group" aria-label={t('analytics.granularity')}>
                  {(['daily', 'weekly'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={granularity === value}
                      onClick={() => setGranularity(value)}
                      className={`rounded-full border px-3 py-1.5 text-xs ${
                        granularity === value
                          ? 'border-brand text-primary'
                          : 'border-border text-tertiary hover:text-primary'
                      }`}
                    >
                      {value === 'daily' ? t('analytics.daily') : t('analytics.weekly')}
                    </button>
                  ))}
                </div>
              </div>
              <SalesChart
                points={points}
                granularity={granularity}
                title={granularity === 'daily' ? 'Ventas por día' : 'Ventas por semana'}
              />
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Pedidos por estado */}
              <section aria-labelledby="status-title" className="surface-card p-4 sm:p-6">
                <h2 id="status-title" className="text-lg font-medium">
                  {t('analytics.ordersByStatus')}
                </h2>
                <p className="mt-1 text-xs text-tertiary">
                  {t('analytics.ordersByStatusHint')}
                </p>
                <ul className="mt-4 space-y-2">
                  {summary.ordersByStatus.map((row) => {
                    const total = Math.max(1, summary.sales.allOrders);
                    const width = Math.round((row.count / total) * 100);
                    return (
                      <li key={row.status} className="flex items-center gap-3 text-sm">
                        <span
                          className={`w-36 shrink-0 truncate rounded-full border px-2 py-0.5 text-xs ${TONE_CLASS[ORDER_STATUS_TONE[row.status]]}`}
                          title={ORDER_STATUS_LABELS[row.status]}
                        >
                          {ORDER_STATUS_LABELS[row.status]}
                        </span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-raised">
                          <span
                            className="block h-full rounded-full bg-brand/70"
                            style={{ width: `${width}%` }}
                          />
                        </span>
                        <span className="w-8 text-right font-mono text-xs text-secondary">
                          {row.count}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Top productos */}
              <section aria-labelledby="top-title" className="surface-card p-4 sm:p-6">
                <h2 id="top-title" className="text-lg font-medium">
                  {t('analytics.topProducts')}
                </h2>
                {summary.topProducts.length === 0 ? (
                  <p className="mt-4 text-sm text-tertiary">{t('analytics.noSales')}</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">
                        {t('analytics.topProductsCaption')}
                      </caption>
                      <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-tertiary">
                          <th scope="col" className="py-2 pr-3 font-medium">
                            {t('analytics.productColumn')}
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-medium">
                            Unid.
                          </th>
                          <th scope="col" className="py-2 text-right font-medium">
                            Ingresos
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.topProducts.map((product) => (
                          <tr key={product.productSlug} className="border-b border-border/60 last:border-0">
                            <th scope="row" className="max-w-[16rem] truncate py-2 pr-3 text-left font-normal">
                              {product.productName}
                            </th>
                            <td className="py-2 pr-3 text-right font-mono text-xs text-secondary">
                              {product.quantity}
                            </td>
                            <td className="py-2 text-right font-mono text-xs">
                              {formatMoney(product.revenueCents, 'PEN', locale)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <StockPanel
            title={t('analytics.lowStockTitle')}
            items={summary.lowStock}
            empty={t('analytics.lowStockEmpty')}
            tone="warning"
          />
              <StockPanel
                title={t('analytics.outOfStockTitle')}
                items={summary.outOfStock}
                empty={t('analytics.outOfStockEmpty')}
                tone="danger"
              />
            </div>

            {/* Regla de negocio explícita */}
            <section className="rounded-2xl border border-border bg-surface-raised/40 p-4 text-xs leading-relaxed text-tertiary">
              <h2 className="mb-1 font-medium text-secondary">{t('analytics.howCounted')}</h2>
              <p>
                {t('analytics.ruleCounted', {
                  statuses: summary.rule.countedStatuses
                    .map((status) => ORDER_STATUS_LABELS[status])
                    .join(', '),
                  payments: summary.rule.paymentStatuses.join(' / '),
                })}{' '}
                {t('analytics.ruleNotCounted')} {t('analytics.ruleMoney')}{' '}
                {t('analytics.ruleBands', { zone: summary.range.timeZone })}{' '}
                {t('analytics.ruleStock')}
              </p>
              {summary.previous.revenueCents > 0 && (
                <p className="mt-2">
                  {t('analytics.changeLine', {
                    revenue: summary.change.revenuePct ?? 0,
                    orders: summary.change.ordersPct ?? 0,
                  })}
                </p>
              )}
            </section>

            <p className="text-xs text-muted">
              {t('analytics.updated', {
                date: formatDate(summary.generatedAt, locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
                lastDay:
                  summary.series.daily.length > 0
                    ? shortDate(summary.series.daily[summary.series.daily.length - 1].date)
                    : '—',
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  change,
  hint,
}: {
  label: string;
  value: string;
  change?: number | null;
  hint?: string;
}) {
  const positive = typeof change === 'number' && change >= 0;
  return (
    <div className="surface-card p-4 sm:p-5">
      <div className="text-xs uppercase tracking-wide text-tertiary">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{value}</div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {typeof change === 'number' && (
          <span
            className={`rounded-full border px-2 py-0.5 ${
              positive
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-destructive/30 bg-destructive/10 text-destructive'
            }`}
          >
            {positive ? '▲' : '▼'} {Math.abs(change)}%
          </span>
        )}
        {hint && <span className="text-muted">{hint}</span>}
      </div>
    </div>
  );
}

function StockPanel({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: AnalyticsSummary['lowStock'];
  empty: string;
  tone: 'warning' | 'danger';
}) {
  const { t } = useI18n();
  const toneClass =
    tone === 'danger'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-warning/30 bg-warning/10 text-warning';

  return (
    <section aria-label={title} className="surface-card p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${toneClass}`}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-tertiary">{empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60">
          {items.slice(0, 10).map((item) => (
            <li
              key={`${item.productSlug}:${item.variantKey}`}
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate">{item.productName}</div>
                <div className="truncate text-xs text-tertiary">{item.variantLabel}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono">{item.available}</div>
                <div className="text-[10px] text-muted">
                  {item.reorderPoint > 0
              ? t('analytics.min', { value: item.reorderPoint })
              : t('analytics.noMin')}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
