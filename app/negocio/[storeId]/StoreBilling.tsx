'use client';

import { useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';
import {
  formatSkuUsage,
  formatUsdCents,
  SUBSCRIPTION_STATUS_LABELS,
  type StoreBillingView,
} from '@/lib/billing';

interface Props {
  storeId: string;
  initialBilling: StoreBillingView;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PE', {
      dateStyle: 'medium',
      timeZone: 'America/Lima',
    }).format(new Date(value));
  } catch {
    return value.slice(0, 10);
  }
}

/**
 * “Plan y facturación” del comerciante.
 *
 * No hay cobro real en staging: los cambios pasan por el provider manual. El
 * backend vuelve a validar owner/admin en cada request; este componente sólo
 * pinta y llama a la API.
 */
export function StoreBilling({ storeId, initialBilling }: Props) {
  const { locale, t } = useI18n();
  const [billing, setBilling] = useState(initialBilling);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promo, setPromo] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const post = async (path: string, body: Record<string, unknown>, mark: string) => {
    setBusy(mark);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/billing/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        billing?: StoreBillingView;
        error?: string;
        code?: string;
        plan?: string;
        limit?: number;
        current?: number;
        requested?: number;
      } | null;
      if (!response.ok || !payload?.billing) {
        if (payload?.code === 'plan_sku_limit_reached') {
          throw new Error(
            t('billing.planLimitReached', {
              plan: payload.plan ?? '',
              limit: payload.limit ?? 0,
              current: payload.current ?? 0,
            }),
          );
        }
        throw new Error(payload?.error ?? t('billing.updateFailed'));
      }
      setBilling(payload.billing);
      setNotice(t('billing.updated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('billing.updateFailed'));
    } finally {
      setBusy(null);
    }
  };

  const changePlan = (planCode: string, targetLimit: number) => {
    const downgrade = targetLimit < billing.plan.skuLimit;
    const overTarget = billing.usage.current > targetLimit;
    const message = downgrade
      ? overTarget
        ? t('billing.downgradeOver', {
            current: billing.usage.current,
            limit: targetLimit,
          })
        : t('billing.downgradeConfirm')
      : t('billing.upgradeConfirm');
    if (!window.confirm(message)) return;
    void post(
      'change-plan',
      { planCode, effective: downgrade ? 'period_end' : 'immediate' },
      `plan:${planCode}`,
    );
  };

  const cancel = () => {
    if (!window.confirm(t('billing.cancelConfirm'))) {
      return;
    }
    void post('cancel', {}, 'cancel');
  };

  const redeem = (event: React.FormEvent) => {
    event.preventDefault();
    if (!promo.trim()) return;
    void post('redeem', { code: promo.trim() }, 'redeem').then(() => setPromo(''));
  };

  const usage = billing.usage;
  const paid = billing.plan.code !== 'free';
  const cancellationPending = billing.subscription.cancelAtPeriodEnd || billing.status === 'cancelled';

  return (
    <section className="mt-8 rounded-2xl border border-border bg-surface p-4" aria-label={t('billing.title')}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">
            {t('billing.title')}
          </h2>
          <p className="mt-1 text-xs text-tertiary">{t('billing.subtitle')}</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-semibold tabular-nums">
            {formatUsdCents(billing.plan.priceCents)}
            <span className="ml-1 text-xs font-normal text-muted">{t('billing.perMonth')}</span>
          </div>
          <div className="text-xs text-secondary">{billing.plan.name}</div>
          <div className="text-[11px] text-tertiary">
            {SUBSCRIPTION_STATUS_LABELS[billing.status] ?? billing.status}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-secondary">{formatSkuUsage(usage.current, usage.limit)}</span>
          <span className="font-mono tabular-nums text-tertiary">{usage.percent}%</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-raised">
          <div
            className={`h-full rounded-full transition-all ${
              usage.overLimit ? 'bg-destructive' : usage.percent >= 80 ? 'bg-warning' : 'bg-success'
            }`}
            style={{ width: `${Math.min(100, usage.percent)}%` }}
          />
        </div>
        {usage.overLimit && (
          <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {t('billing.overLimitBody', {
              current: usage.current,
              plan: billing.plan.name,
              limit: usage.limit,
            })}
          </p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted">{t('billing.nextRenewal')}</dt>
          <dd className="text-secondary">{formatDate(billing.nextRenewalAt, locale)}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('billing.currency')}</dt>
          <dd className="text-secondary">{billing.plan.currency}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('billing.provider')}</dt>
          <dd className="text-secondary">
            {billing.subscription.provider === 'manual'
              ? t('billing.manual')
              : billing.subscription.provider}
          </dd>
        </div>
      </dl>

      {billing.pendingPlan && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          <span>
            {t('billing.pendingChange', {
              plan: billing.pendingPlan.name,
              date: formatDate(billing.subscription.pendingPlanEffectiveAt, locale),
            })}
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void post('change-plan', { planCode: billing.plan.code, effective: 'immediate' }, 'keep')}
            className="rounded-md border border-warning/50 px-2 py-1 text-[11px] disabled:opacity-50"
          >
            {t('billing.keep', { plan: billing.plan.name })}
          </button>
        </div>
      )}
      {cancellationPending && (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          {t('billing.cancellationPending', {
            plan: billing.plan.name,
            date: formatDate(billing.subscription.currentPeriodEnd, locale),
          })}
        </p>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {billing.availablePlans
          .filter((plan) => plan.code !== billing.plan.code && plan.code !== 'free')
          .map((plan) => (
            <div key={plan.id} className="rounded-xl border border-border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{plan.name}</span>
                <span className="font-mono text-xs tabular-nums">{formatUsdCents(plan.priceCents)}</span>
              </div>
              <p className="mt-0.5 text-xs text-tertiary">
                {t('billing.upTo', { limit: plan.skuLimit })}
              </p>
              <button
                type="button"
                onClick={() => changePlan(plan.code, plan.skuLimit)}
                disabled={busy !== null}
                className="mt-2 h-8 w-full rounded-lg border border-border-strong text-xs hover:bg-surface-raised disabled:opacity-50"
              >
                {busy === `plan:${plan.code}`
                  ? t('billing.applying')
                  : plan.skuLimit > billing.plan.skuLimit
                    ? t('billing.upgradeTo', { plan: plan.name })
                    : t('billing.schedule', { plan: plan.name })}
              </button>
            </div>
          ))}
      </div>

      {paid && !cancellationPending && (
        <button
          type="button"
          onClick={cancel}
          disabled={busy !== null}
          className="mt-3 h-8 rounded-lg border border-border px-3 text-xs text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          {busy === 'cancel' ? t('billing.cancelling') : t('billing.cancelAtEnd')}
        </button>
      )}

      <form onSubmit={redeem} className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        <input
          value={promo}
          onChange={(event) => setPromo(event.target.value.toUpperCase())}
          placeholder={t('billing.promoPlaceholder')}
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs uppercase tracking-wide outline-none focus:border-primary"
          maxLength={40}
          aria-label={t('billing.promoLabel')}
        />
        <button
          type="submit"
          disabled={busy !== null || !promo.trim()}
          className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background disabled:opacity-50"
        >
          {busy === 'redeem' ? t('billing.redeeming') : t('billing.redeem')}
        </button>
      </form>
      {!paid && (
        <p className="mt-2 text-[11px] text-tertiary">{t('billing.freePromoNote')}</p>
      )}

      {error && <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
      {notice && <p className="mt-3 text-xs text-success">{notice}</p>}
    </section>
  );
}
