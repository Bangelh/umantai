'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';
import {
  formatSkuUsage,
  formatUsdCents,
  SUBSCRIPTION_STATUS_LABELS,
  type AdminSubscriptionRow,
  type PlanView,
  type PromotionView,
  type StoreBillingView,
  type SubscriptionEventView,
} from '@/lib/billing';

interface SubscriptionsResponse {
  subscriptions: AdminSubscriptionRow[];
  plans: PlanView[];
}

interface HistoryResponse {
  billing: StoreBillingView;
  events: SubscriptionEventView[];
}

/**
 * /admin/planes — Platform Admin de planes/suscripciones.
 *
 * Separado del panel del comerciante. Usa la sesión de Platform Admin (cookie
 * firmada); el token compartido ya no se pide en la UI. No comparte sesión ni
 * datos con Store Admin.
 */
export default function AdminPlansPage() {
  const { t } = useI18n();
  const admin = usePlatformAdminSession();
  const sessionEmail = admin.email;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [subscriptions, setSubscriptions] = useState<AdminSubscriptionRow[]>([]);
  const [promotions, setPromotions] = useState<PromotionView[]>([]);
  const [planDrafts, setPlanDrafts] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<HistoryResponse | null>(null);

  const [promoCode, setPromoCode] = useState('');
  const [promoName, setPromoName] = useState('');
  const [promoPlan, setPromoPlan] = useState('');
  const [promoMax, setPromoMax] = useState('');
  const [promoMonths, setPromoMonths] = useState('1');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [plansResponse, subsResponse, promosResponse] = await Promise.all([
        fetch('/api/admin/plans', withAdminAuth()),
        fetch('/api/admin/billing/subscriptions', withAdminAuth()),
        fetch('/api/admin/promotions', withAdminAuth()),
      ]);
      if (!plansResponse.ok || !subsResponse.ok || !promosResponse.ok) {
        const payload = (await subsResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? t('adminPlans.notAuthorized'));
      }
      const plansPayload = (await plansResponse.json()) as { plans: PlanView[] };
      const subsPayload = (await subsResponse.json()) as SubscriptionsResponse;
      const promosPayload = (await promosResponse.json()) as { promotions: PromotionView[] };
      setPlans(plansPayload.plans ?? []);
      setSubscriptions(subsPayload.subscriptions ?? []);
      setPromotions(promosPayload.promotions ?? []);
      setPlanDrafts(
        Object.fromEntries((subsPayload.subscriptions ?? []).map((row) => [row.storeId, row.plan.code])),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminPlans.notAuthorized'));
    } finally {
      setBusy(false);
    }
  }, []);

  // Con sesión de Platform Admin activa, carga los datos una vez.
  useEffect(() => {
    if (admin.status === 'authenticated') void load();
  }, [admin.status, load]);

  const adminPost = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        path,
        withAdminAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const payload = (await response.json().catch(() => null)) as {
        billing?: StoreBillingView;
        promotion?: PromotionView;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error ?? t('adminPlans.operationFailed'));
      setNotice(t('adminPlans.operationApplied'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminPlans.operationFailed'));
    } finally {
      setBusy(false);
    }
  };

  const changePlan = (row: AdminSubscriptionRow) => {
    const target = planDrafts[row.storeId] ?? row.plan.code;
    if (target === row.plan.code) return;
    const targetPlan = plans.find((plan) => plan.code === target);
    if (targetPlan && row.usage.current > targetPlan.skuLimit) {
      const ok = window.confirm(
        t('adminPlans.overLimitConfirm', {
          current: row.usage.current,
          plan: targetPlan.name,
          limit: targetPlan.skuLimit,
        }),
      );
      if (!ok) return;
    }
    void adminPost(`/api/admin/billing/subscriptions/${row.storeId}/change-plan`, {
      planCode: target,
      effective: 'immediate',
      reason: 'platform_admin_change_plan',
    });
  };

  const grantMonth = (row: AdminSubscriptionRow) => {
    if (!window.confirm(t('adminPlans.monthsConfirm', { store: row.storeName }))) return;
    void adminPost(`/api/admin/billing/subscriptions/${row.storeId}/grant-month`, {
      months: 1,
      reason: 'platform_admin_grant',
    });
  };

  const simulateFailure = (row: AdminSubscriptionRow) => {
    if (!window.confirm(t('adminPlans.failureConfirm', { store: row.storeName }))) return;
    void adminPost(`/api/admin/billing/subscriptions/${row.storeId}/simulate-payment-failure`, {
      reason: 'platform_admin_simulated_failure',
    });
  };

  const openHistory = async (row: AdminSubscriptionRow) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/billing/subscriptions/${row.storeId}/history`,
        withAdminAuth(),
      );
      const payload = (await response.json().catch(() => null)) as (HistoryResponse & { error?: string }) | null;
      if (!response.ok || !payload) throw new Error(payload?.error ?? t('adminPlans.historyFailed'));
      setHistory({ billing: payload.billing, events: payload.events ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminPlans.historyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const createPromotion = (event: React.FormEvent) => {
    event.preventDefault();
    void adminPost('/api/admin/promotions', {
      code: promoCode,
      name: promoName,
      planCode: promoPlan || null,
      durationMonths: Number(promoMonths) || 1,
      maxRedemptions: promoMax ? Number(promoMax) : null,
      active: true,
    }).then(() => {
      setPromoCode('');
      setPromoName('');
      setPromoMax('');
    });
  };

  const togglePromotion = async (promotion: PromotionView) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/promotions/${promotion.id}`,
        withAdminAuth({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !promotion.active }),
        }),
      );
      if (!response.ok) throw new Error(t('adminPlans.updateFailed'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminPlans.updateFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen
        title={t('adminPlans.title')}
        status={admin.status}
        onActivate={admin.activate}
      />
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="text-xs text-muted">
            <Link href="/admin" className="hover:text-primary">Admin</Link> / {t('adminPlans.title')}
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('adminPlans.title')}</h1>
          <p className="mt-1 text-sm text-tertiary">{t('adminPlans.subtitle')}</p>
          {sessionEmail && (
            <p className="mt-1 text-xs text-success">
              {t('admin.signedInAs', { email: sessionEmail })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="h-9 rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised disabled:opacity-50"
          >
            {t('adminPlans.refresh')}
          </button>
          <button
            type="button"
            onClick={() => void admin.signOut()}
            className="h-9 rounded-xl border border-border px-3 text-xs text-tertiary"
          >
            {t('admin.signOut')}
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {notice && <p className="mt-4 text-sm text-success">{notice}</p>}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">{t('adminPlans.catalog')}</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {plans.map((plan) => (
            <div key={plan.id} className={`rounded-xl border p-3 ${plan.active ? 'border-border' : 'border-dashed border-border opacity-60'}`}>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{plan.name}</span>
                <span className="font-mono text-sm tabular-nums">{formatUsdCents(plan.priceCents)}</span>
              </div>
              <p className="mt-1 text-xs text-tertiary">{plan.skuLimit} SKU · {plan.currency} / {plan.billingInterval}</p>
              <p className="mt-1 text-[11px] text-muted">
                code: {plan.code} · {plan.active ? t('adminPlans.active') : t('adminPlans.inactive')}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">{t('adminPlans.stores')}</h2>
          <span className="text-xs text-muted tabular-nums">{subscriptions.length}</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="py-2 font-medium">{t('adminPlans.store')}</th>
                <th className="py-2 font-medium">{t('adminPlans.planStatus')}</th>
                <th className="py-2 font-medium">{t('adminPlans.sku')}</th>
                <th className="py-2 font-medium">{t('adminPlans.renews')}</th>
                <th className="py-2 font-medium">{t('adminPlans.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {subscriptions.map((row) => (
                <tr key={row.storeId} className="align-top">
                  <td className="py-2.5">
                    <div className="font-medium text-foreground">{row.storeName}</div>
                    <div className="text-muted">
                      /{row.storeSlug} ·{' '}
                      {row.storeActive ? t('adminPlans.storeActive') : t('adminPlans.storeInactive')}
                    </div>
                  </td>
                  <td className="py-2.5">
                    <div>{row.plan.name} · {row.plan.currency} {formatUsdCents(row.plan.priceCents)}</div>
                    <div className="text-muted">
                      {SUBSCRIPTION_STATUS_LABELS[row.status] ?? row.status}
                      {row.cancelAtPeriodEnd ? ` · ${t('adminPlans.cancelScheduled')}` : ''}
                      {row.pendingPlanCode
                        ? ` · ${t('adminPlans.pendingPlan', { code: row.pendingPlanCode })}`
                        : ''}
                    </div>
                  </td>
                  <td className="py-2.5">
                    <div className={row.usage.overLimit ? 'text-destructive' : ''}>
                      {formatSkuUsage(row.usage.current, row.usage.limit)}
                    </div>
                    {row.usage.overLimit && <div className="text-[10px] text-destructive">over_limit</div>}
                  </td>
                  <td className="py-2.5 font-mono text-[11px] text-tertiary">
                    {row.currentPeriodEnd ? row.currentPeriodEnd.slice(0, 10) : '—'}
                  </td>
                  <td className="py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <select
                        value={planDrafts[row.storeId] ?? row.plan.code}
                        onChange={(event) =>
                          setPlanDrafts((current) => ({ ...current, [row.storeId]: event.target.value }))
                        }
                        className="h-8 rounded-lg border border-border bg-surface px-2 text-xs"
                      >
                        {plans.map((plan) => (
                          <option key={plan.id} value={plan.code}>{plan.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || (planDrafts[row.storeId] ?? row.plan.code) === row.plan.code}
                        onClick={() => changePlan(row)}
                        className="h-8 rounded-lg border border-border-strong px-2 text-xs disabled:opacity-40"
                      >
                        {t('adminPlans.apply')}
                      </button>
                      <button
                        type="button"
                        disabled={busy || row.plan.code === 'free'}
                        onClick={() => grantMonth(row)}
                        className="h-8 rounded-lg border border-border px-2 text-xs disabled:opacity-40"
                      >
                        {t('adminPlans.grantMonth')}
                      </button>
                      <button
                        type="button"
                        disabled={busy || row.plan.code === 'free'}
                        onClick={() => simulateFailure(row)}
                        className="h-8 rounded-lg border border-border px-2 text-xs disabled:opacity-40"
                      >
                        {t('adminPlans.simulateFailure')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void openHistory(row)}
                        className="h-8 rounded-lg border border-border px-2 text-xs"
                      >
                        {t('adminPlans.history')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">{t('adminPlans.promos')}</h2>
        <form onSubmit={createPromotion} className="mt-2 grid gap-2 sm:grid-cols-6">
          <input
            value={promoCode}
            onChange={(event) => setPromoCode(event.target.value.toUpperCase())}
            placeholder={t('adminPlans.code')}
            className="h-9 rounded-lg border border-border bg-surface px-2 font-mono text-xs uppercase"
            required
          />
          <input
            value={promoName}
            onChange={(event) => setPromoName(event.target.value)}
            placeholder={t('adminPlans.promoName')}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs sm:col-span-2"
            required
          />
          <select
            value={promoPlan}
            onChange={(event) => setPromoPlan(event.target.value)}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
          >
            <option value="">{t('adminPlans.anyPaidPlan')}</option>
            {plans.filter((plan) => plan.code !== 'free').map((plan) => (
              <option key={plan.id} value={plan.code}>{plan.name}</option>
            ))}
          </select>
          <input
            value={promoMonths}
            onChange={(event) => setPromoMonths(event.target.value)}
            placeholder={t('adminPlans.months')}
            type="number"
            min="1"
            max="24"
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
          />
          <input
            value={promoMax}
            onChange={(event) => setPromoMax(event.target.value)}
            placeholder={t('adminPlans.maxRedemptions')}
            type="number"
            min="1"
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
          />
          <button
            type="submit"
            disabled={busy || !promoCode.trim() || !promoName.trim()}
            className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background disabled:opacity-50 sm:col-span-1"
          >
            {t('adminPlans.createCode')}
          </button>
        </form>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="py-2 font-medium">{t('adminPlans.code')}</th>
                <th className="py-2 font-medium">{t('adminPlans.benefit')}</th>
                <th className="py-2 font-medium">{t('adminPlans.plan')}</th>
                <th className="py-2 font-medium">{t('adminPlans.redemptions')}</th>
                <th className="py-2 font-medium">{t('adminPlans.status')}</th>
                <th className="py-2 font-medium">{t('adminPlans.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {promotions.map((promotion) => (
                <tr key={promotion.id}>
                  <td className="py-2 font-mono">{promotion.code}</td>
                  <td className="py-2">
                    {t('adminPlans.monthsBenefit', { count: promotion.durationMonths })}
                  </td>
                  <td className="py-2">{promotion.planCode ?? t('adminPlans.anyPaidPlanShort')}</td>
                  <td className="py-2 font-mono tabular-nums">
                    {promotion.redemptionCount}{promotion.maxRedemptions ? ` / ${promotion.maxRedemptions}` : ''}
                  </td>
                  <td className="py-2">
                    {promotion.active ? t('adminPlans.active') : t('adminPlans.inactive')}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void togglePromotion(promotion)}
                      className="h-7 rounded-lg border border-border px-2 text-xs disabled:opacity-40"
                    >
                      {promotion.active ? t('adminPlans.deactivate') : t('adminPlans.activate')}
                    </button>
                  </td>
                </tr>
              ))}
              {promotions.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-tertiary">{t('adminPlans.noCodes')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {history && (
        <section className="mt-8 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-3 border-b border-border pb-2">
            <div>
              <h2 className="text-sm font-semibold">
                {t('adminPlans.historyTitle')} · {history.billing.storeName}
              </h2>
              <p className="text-xs text-tertiary">
                {history.billing.plan.name} · {formatSkuUsage(history.billing.usage.current, history.billing.usage.limit)}
              </p>
            </div>
            <button type="button" onClick={() => setHistory(null)} className="text-xs text-muted hover:text-primary">
              {t('adminPlans.close')}
            </button>
          </div>
          <ul className="mt-2 divide-y divide-border text-xs">
            {history.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <div>
                  <span className="font-mono">{event.eventType}</span>
                  <span className="ml-2 text-tertiary">
                    {event.fromPlanCode ?? '—'} → {event.toPlanCode ?? '—'}
                    {event.statusFrom ? ` · ${event.statusFrom} → ${event.statusTo}` : ''}
                  </span>
                  {event.reason && <span className="ml-2 text-muted">({event.reason})</span>}
                </div>
                <span className="text-muted">{event.createdAt.slice(0, 16).replace('T', ' ')}</span>
              </li>
            ))}
            {history.events.length === 0 && (
              <li className="py-3 text-tertiary">{t('adminPlans.noEvents')}</li>
            )}
          </ul>
        </section>
      )}
    </main>
  );
}
