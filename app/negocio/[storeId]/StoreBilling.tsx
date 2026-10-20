'use client';

import { useState } from 'react';
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

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('es-PE', {
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
            `Tu plan ${payload.plan} permite ${payload.limit} SKU y usas ${payload.current}. ` +
              'Archiva o despublica productos antes de publicar más.',
          );
        }
        throw new Error(payload?.error ?? 'No se pudo actualizar el plan.');
      }
      setBilling(payload.billing);
      setNotice('Plan actualizado.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el plan.');
    } finally {
      setBusy(null);
    }
  };

  const changePlan = (planCode: string, targetLimit: number) => {
    const downgrade = targetLimit < billing.plan.skuLimit;
    const overTarget = billing.usage.current > targetLimit;
    const message = downgrade
      ? overTarget
        ? `Tu tienda usa ${billing.usage.current} SKU y el plan destino permite ${targetLimit}. ` +
          'El cambio se programará al final del período y las nuevas publicaciones quedarán bloqueadas hasta bajar del límite.'
        : 'El cambio de plan se programará al final del período actual.'
      : 'El upgrade se aplica ahora en staging.';
    if (!window.confirm(message)) return;
    void post(
      'change-plan',
      { planCode, effective: downgrade ? 'period_end' : 'immediate' },
      `plan:${planCode}`,
    );
  };

  const cancel = () => {
    if (!window.confirm('¿Cancelar el plan de pago? Conservarás los beneficios hasta el final del período.')) {
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
    <section className="mt-8 rounded-2xl border border-border bg-surface p-4" aria-label="Plan y facturación">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Plan y facturación</h2>
          <p className="mt-1 text-xs text-tertiary">
            Cobro recurrente de UMANTAI. Separado del pago de pedidos de tus clientes.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-semibold tabular-nums">
            {formatUsdCents(billing.plan.priceCents)}
            <span className="ml-1 text-xs font-normal text-muted">/mes</span>
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
            Tu tienda usa {usage.current} SKU y el plan {billing.plan.name} permite {usage.limit}. Los
            productos publicados siguen visibles, pero no puedes publicar ni activar más SKU hasta
            archivar/despublicar o mejorar de plan.
          </p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted">Próxima renovación</dt>
          <dd className="text-secondary">{formatDate(billing.nextRenewalAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Moneda</dt>
          <dd className="text-secondary">{billing.plan.currency}</dd>
        </div>
        <div>
          <dt className="text-muted">Proveedor</dt>
          <dd className="text-secondary">
            {billing.subscription.provider === 'manual' ? 'Manual (staging)' : billing.subscription.provider}
          </dd>
        </div>
      </dl>

      {billing.pendingPlan && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          <span>
            Cambio programado a {billing.pendingPlan.name} el {formatDate(billing.subscription.pendingPlanEffectiveAt)}.
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void post('change-plan', { planCode: billing.plan.code, effective: 'immediate' }, 'keep')}
            className="rounded-md border border-warning/50 px-2 py-1 text-[11px] disabled:opacity-50"
          >
            Mantener {billing.plan.name}
          </button>
        </div>
      )}
      {cancellationPending && (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          Cancelación programada. Mantienes {billing.plan.name} hasta {formatDate(billing.subscription.currentPeriodEnd)}.
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
              <p className="mt-0.5 text-xs text-tertiary">Hasta {plan.skuLimit} SKU</p>
              <button
                type="button"
                onClick={() => changePlan(plan.code, plan.skuLimit)}
                disabled={busy !== null}
                className="mt-2 h-8 w-full rounded-lg border border-border-strong text-xs hover:bg-surface-raised disabled:opacity-50"
              >
                {busy === `plan:${plan.code}`
                  ? 'Aplicando…'
                  : plan.skuLimit > billing.plan.skuLimit
                    ? `Subir a ${plan.name}`
                    : `Programar ${plan.name}`}
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
          {busy === 'cancel' ? 'Cancelando…' : 'Cancelar plan al final del período'}
        </button>
      )}

      <form onSubmit={redeem} className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        <input
          value={promo}
          onChange={(event) => setPromo(event.target.value.toUpperCase())}
          placeholder="Código +1 mes"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs uppercase tracking-wide outline-none focus:border-primary"
          maxLength={40}
          aria-label="Código promocional"
        />
        <button
          type="submit"
          disabled={busy !== null || !promo.trim()}
          className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background disabled:opacity-50"
        >
          {busy === 'redeem' ? 'Canjeando…' : 'Canjear'}
        </button>
      </form>
      {!paid && (
        <p className="mt-2 text-[11px] text-tertiary">
          Los códigos de mes gratis aplican a un plan de pago; no convierten Free en un plan pago automáticamente.
        </p>
      )}

      {error && <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
      {notice && <p className="mt-3 text-xs text-success">{notice}</p>}
    </section>
  );
}
