'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { clearAdminToken, setAdminToken, withAdminAuth } from '@/lib/adminAuth';
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
 * Separado del panel del comerciante. Usa el mismo ADMIN_API_SECRET temporal
 * (x-admin-token) que el resto de /admin. No comparte sesión ni datos con
 * Store Admin.
 */
export default function AdminPlansPage() {
  const [token, setTokenState] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
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

  const load = useCallback(async (candidate = token) => {
    setBusy(true);
    setError(null);
    try {
      const [plansResponse, subsResponse, promosResponse] = await Promise.all([
        fetch('/api/admin/plans', withAdminAuth({}, candidate)),
        fetch('/api/admin/billing/subscriptions', withAdminAuth({}, candidate)),
        fetch('/api/admin/promotions', withAdminAuth({}, candidate)),
      ]);
      if (!plansResponse.ok || !subsResponse.ok || !promosResponse.ok) {
        const payload = (await subsResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'No autorizado.');
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
      setAuthorized(true);
      setAdminToken(candidate);
    } catch (err) {
      setAuthorized(false);
      setError(err instanceof Error ? err.message : 'No autorizado.');
    } finally {
      setBusy(false);
    }
  }, [token]);

  const activateSession = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/session', { method: 'POST' });
      const payload = (await response.json().catch(() => null)) as {
        authenticated?: boolean;
        user?: { email?: string } | null;
        error?: string;
      } | null;
      if (!response.ok || !payload?.authenticated) {
        throw new Error(payload?.error ?? 'No se pudo activar la sesión de administrador.');
      }
      setSessionEmail(payload.user?.email ?? null);
      await load('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo activar la sesión.');
    } finally {
      setBusy(false);
    }
  };

  // Al abrir: si ya hay sesión de admin, carga; si hay sesión de Better Auth
  // autorizada, la canjea por la cookie firmada. No hay parpadeo de token.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void (async () => {
      try {
        const stateResponse = await fetch('/api/admin/session', { cache: 'no-store' });
        const state = (await stateResponse.json().catch(() => null)) as {
          authenticated?: boolean;
          user?: { email?: string } | null;
        } | null;
        if (state?.authenticated) {
          setSessionEmail(state.user?.email ?? null);
          await load('');
          return;
        }
        const response = await fetch('/api/admin/session', { method: 'POST' });
        const payload = (await response.json().catch(() => null)) as {
          authenticated?: boolean;
          user?: { email?: string } | null;
        } | null;
        if (response.ok && payload?.authenticated) {
          setSessionEmail(payload.user?.email ?? null);
          await load('');
        }
      } catch {
        // Sin sesión: queda el formulario de token / login.
      }
    })();
  }, [load]);

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
      if (!response.ok) throw new Error(payload?.error ?? 'La operación falló.');
      setNotice('Operación aplicada.');
      await load(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La operación falló.');
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
        `La tienda usa ${row.usage.current} SKU y ${targetPlan.name} permite ${targetPlan.skuLimit}. ` +
          'Quedará over_limit: los productos siguen visibles, pero se bloquean nuevas publicaciones. ¿Aplicar igual?',
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
    if (!window.confirm(`¿Otorgar +1 mes gratis a ${row.storeName}?`)) return;
    void adminPost(`/api/admin/billing/subscriptions/${row.storeId}/grant-month`, {
      months: 1,
      reason: 'platform_admin_grant',
    });
  };

  const simulateFailure = (row: AdminSubscriptionRow) => {
    if (!window.confirm(`¿Simular fallo de pago para ${row.storeName}? (sólo staging)`)) return;
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
        withAdminAuth({}, token),
      );
      const payload = (await response.json().catch(() => null)) as (HistoryResponse & { error?: string }) | null;
      if (!response.ok || !payload) throw new Error(payload?.error ?? 'No se pudo leer el historial.');
      setHistory({ billing: payload.billing, events: payload.events ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer el historial.');
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
      if (!response.ok) throw new Error('No se pudo actualizar el código.');
      await load(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el código.');
    } finally {
      setBusy(false);
    }
  };

  if (!authorized) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-2xl font-semibold">Planes y suscripciones</h1>
        <p className="mt-1 text-sm text-tertiary">
          Platform Admin de UMANTAI. Inicia sesión con una cuenta autorizada.
        </p>
        <div className="mt-6 space-y-2">
          <button
            type="button"
            onClick={() => void activateSession()}
            disabled={busy}
            className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50"
          >
            {busy ? 'Comprobando…' : 'Activar sesión de administrador'}
          </button>
          <Link
            href="/ingresar?next=%2Fadmin%2Fplanes"
            className="block text-center text-xs text-tertiary underline underline-offset-4 hover:text-primary"
          >
            Iniciar sesión con mi cuenta
          </Link>
        </div>
        <details className="mt-4 rounded-xl border border-border p-3 text-xs text-tertiary">
          <summary className="cursor-pointer text-secondary">Respaldo de desarrollo (token)</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load(token);
          }}
          className="mt-6 space-y-3"
        >
          <input
            type="password"
            value={token}
            onChange={(event) => setTokenState(event.target.value)}
            placeholder="Token de administración"
            className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-background disabled:opacity-50"
          >
            {busy ? 'Verificando…' : 'Entrar'}
          </button>
        </form>
        </details>
        {error && <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        <Link href="/admin" className="mt-6 inline-block text-xs text-muted hover:text-primary">
          ← Panel de administración
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="text-xs text-muted">
            <Link href="/admin" className="hover:text-primary">Admin</Link> / Planes
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Planes y suscripciones</h1>
          <p className="mt-1 text-sm text-tertiary">
            Free 25 · Starter US$4/50 SKU · Growth US$6/100 SKU. Provider actual: manual/test.
          </p>
          {sessionEmail && (
            <p className="mt-1 text-xs text-success">Sesión de administrador: {sessionEmail}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load(token)}
            disabled={busy}
            className="h-9 rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised disabled:opacity-50"
          >
            Actualizar
          </button>
          <button
            type="button"
            onClick={() => {
              clearAdminToken();
              setAuthorized(false);
              setTokenState('');
              setSessionEmail(null);
              void fetch('/api/admin/session', { method: 'DELETE' });
            }}
            className="h-9 rounded-xl border border-border px-3 text-xs text-tertiary"
          >
            Salir
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {notice && <p className="mt-4 text-sm text-success">{notice}</p>}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Catálogo de planes</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {plans.map((plan) => (
            <div key={plan.id} className={`rounded-xl border p-3 ${plan.active ? 'border-border' : 'border-dashed border-border opacity-60'}`}>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{plan.name}</span>
                <span className="font-mono text-sm tabular-nums">{formatUsdCents(plan.priceCents)}</span>
              </div>
              <p className="mt-1 text-xs text-tertiary">{plan.skuLimit} SKU · {plan.currency} / {plan.billingInterval}</p>
              <p className="mt-1 text-[11px] text-muted">code: {plan.code} · {plan.active ? 'activo' : 'inactivo'}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Tiendas</h2>
          <span className="text-xs text-muted tabular-nums">{subscriptions.length}</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="py-2 font-medium">Tienda</th>
                <th className="py-2 font-medium">Plan / estado</th>
                <th className="py-2 font-medium">SKU</th>
                <th className="py-2 font-medium">Renueva</th>
                <th className="py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {subscriptions.map((row) => (
                <tr key={row.storeId} className="align-top">
                  <td className="py-2.5">
                    <div className="font-medium text-foreground">{row.storeName}</div>
                    <div className="text-muted">/{row.storeSlug} · {row.storeActive ? 'activa' : 'inactiva'}</div>
                  </td>
                  <td className="py-2.5">
                    <div>{row.plan.name} · {row.plan.currency} {formatUsdCents(row.plan.priceCents)}</div>
                    <div className="text-muted">
                      {SUBSCRIPTION_STATUS_LABELS[row.status] ?? row.status}
                      {row.cancelAtPeriodEnd ? ' · cancelación programada' : ''}
                      {row.pendingPlanCode ? ` · pendiente ${row.pendingPlanCode}` : ''}
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
                        Aplicar
                      </button>
                      <button
                        type="button"
                        disabled={busy || row.plan.code === 'free'}
                        onClick={() => grantMonth(row)}
                        className="h-8 rounded-lg border border-border px-2 text-xs disabled:opacity-40"
                      >
                        +1 mes
                      </button>
                      <button
                        type="button"
                        disabled={busy || row.plan.code === 'free'}
                        onClick={() => simulateFailure(row)}
                        className="h-8 rounded-lg border border-border px-2 text-xs disabled:opacity-40"
                      >
                        Fallo pago
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void openHistory(row)}
                        className="h-8 rounded-lg border border-border px-2 text-xs"
                      >
                        Historial
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
        <h2 className="text-sm font-semibold uppercase tracking-[2px] text-secondary">Códigos +1 mes</h2>
        <form onSubmit={createPromotion} className="mt-2 grid gap-2 sm:grid-cols-6">
          <input
            value={promoCode}
            onChange={(event) => setPromoCode(event.target.value.toUpperCase())}
            placeholder="CÓDIGO"
            className="h-9 rounded-lg border border-border bg-surface px-2 font-mono text-xs uppercase"
            required
          />
          <input
            value={promoName}
            onChange={(event) => setPromoName(event.target.value)}
            placeholder="Nombre"
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs sm:col-span-2"
            required
          />
          <select
            value={promoPlan}
            onChange={(event) => setPromoPlan(event.target.value)}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
          >
            <option value="">Cualquier plan pago</option>
            {plans.filter((plan) => plan.code !== 'free').map((plan) => (
              <option key={plan.id} value={plan.code}>{plan.name}</option>
            ))}
          </select>
          <input
            value={promoMonths}
            onChange={(event) => setPromoMonths(event.target.value)}
            placeholder="Meses"
            type="number"
            min="1"
            max="24"
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
          />
          <input
            value={promoMax}
            onChange={(event) => setPromoMax(event.target.value)}
            placeholder="Máx. canjes"
            type="number"
            min="1"
            className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
          />
          <button
            type="submit"
            disabled={busy || !promoCode.trim() || !promoName.trim()}
            className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background disabled:opacity-50 sm:col-span-1"
          >
            Crear código
          </button>
        </form>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="py-2 font-medium">Código</th>
                <th className="py-2 font-medium">Beneficio</th>
                <th className="py-2 font-medium">Plan</th>
                <th className="py-2 font-medium">Canjes</th>
                <th className="py-2 font-medium">Estado</th>
                <th className="py-2 font-medium">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {promotions.map((promotion) => (
                <tr key={promotion.id}>
                  <td className="py-2 font-mono">{promotion.code}</td>
                  <td className="py-2">+{promotion.durationMonths} mes(es)</td>
                  <td className="py-2">{promotion.planCode ?? 'cualquiera pago'}</td>
                  <td className="py-2 font-mono tabular-nums">
                    {promotion.redemptionCount}{promotion.maxRedemptions ? ` / ${promotion.maxRedemptions}` : ''}
                  </td>
                  <td className="py-2">{promotion.active ? 'activo' : 'inactivo'}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void togglePromotion(promotion)}
                      className="h-7 rounded-lg border border-border px-2 text-xs disabled:opacity-40"
                    >
                      {promotion.active ? 'Desactivar' : 'Activar'}
                    </button>
                  </td>
                </tr>
              ))}
              {promotions.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-tertiary">Todavía no hay códigos.</td>
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
              <h2 className="text-sm font-semibold">Historial · {history.billing.storeName}</h2>
              <p className="text-xs text-tertiary">
                {history.billing.plan.name} · {formatSkuUsage(history.billing.usage.current, history.billing.usage.limit)}
              </p>
            </div>
            <button type="button" onClick={() => setHistory(null)} className="text-xs text-muted hover:text-primary">
              Cerrar
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
            {history.events.length === 0 && <li className="py-3 text-tertiary">Sin eventos.</li>}
          </ul>
        </section>
      )}
    </main>
  );
}
