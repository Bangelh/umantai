/**
 * lib/billing/subscriptions.server.ts — ciclo de vida de la suscripción.
 *
 * Contrato:
 *   · UNA suscripción principal por tienda (`store_subscriptions.store_id` UNIQUE).
 *   · Free es una fila explícita, nunca NULL.
 *   · Toda transición deja un evento en `subscription_events` (append-only).
 *   · El cron/renovación es idempotente: actualiza sólo si el período venció y
 *     el evento usa `idempotency_key` único.
 *
 * Este módulo NO toca Mercado Pago de pedidos. El cobro real de planes queda
 * detrás de `BillingProvider` (hoy: manual/test).
 */

import {
  BillingError,
  FREE_PLAN_CODE,
  addMonthsUtc,
  isPaidPlanCode,
  skuUsage,
  type PlanView,
  type StoreBillingView,
  type StoreSubscriptionView,
  type SubscriptionEventView,
  type SubscriptionStatus,
  type AdminSubscriptionRow,
} from '@/lib/billing';
import type { Row, SqlClient } from '@/lib/db-driver.server';
import { requirePlatformSql, toIsoString, toNumber } from '@/lib/platform-db.server';
import { requireStoreAccess } from '@/lib/stores.server';
import { countStoreSkus, refreshStoreOverLimit } from './sku.server';

const MANUAL_PROVIDER = 'manual';

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return toIsoString(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toPlan(row: Row): PlanView {
  return {
    id: String(row.plan_id ?? row.id),
    code: String(row.plan_code ?? row.code),
    name: String(row.plan_name ?? row.name),
    priceCents: toNumber(row.price_cents),
    currency: String(row.currency ?? 'USD'),
    billingInterval: String(row.billing_interval ?? 'month') === 'year' ? 'year' : 'month',
    skuLimit: toNumber(row.sku_limit),
    active: row.active !== false,
    sortOrder: toNumber(row.sort_order),
    features: jsonObject(row.features),
  };
}

function toSubscription(row: Row): StoreSubscriptionView {
  return {
    id: String(row.id),
    storeId: String(row.store_id),
    planId: String(row.plan_id),
    planCode: String(row.plan_code),
    planName: String(row.plan_name),
    priceCents: toNumber(row.price_cents),
    currency: String(row.currency ?? 'USD'),
    billingInterval: String(row.billing_interval ?? 'month') === 'year' ? 'year' : 'month',
    skuLimit: toNumber(row.sku_limit),
    status: String(row.status) as SubscriptionStatus,
    currentPeriodStart: toIsoString(row.current_period_start),
    currentPeriodEnd: nullableIso(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    cancelledAt: nullableIso(row.cancelled_at),
    provider: String(row.provider ?? MANUAL_PROVIDER),
    providerCustomerId: row.provider_customer_id ? String(row.provider_customer_id) : null,
    providerSubscriptionId: row.provider_subscription_id ? String(row.provider_subscription_id) : null,
    pendingPlanId: row.pending_plan_id ? String(row.pending_plan_id) : null,
    pendingPlanCode: row.pending_plan_code ? String(row.pending_plan_code) : null,
    pendingPlanName: row.pending_plan_name ? String(row.pending_plan_name) : null,
    pendingPlanEffectiveAt: nullableIso(row.pending_plan_effective_at),
    overLimitAt: nullableIso(row.over_limit_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toEvent(row: Row): SubscriptionEventView {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    fromPlanCode: row.from_plan_code ? String(row.from_plan_code) : null,
    toPlanCode: row.to_plan_code ? String(row.to_plan_code) : null,
    statusFrom: row.status_from ? String(row.status_from) : null,
    statusTo: row.status_to ? String(row.status_to) : null,
    amountCents: row.amount_cents === null || row.amount_cents === undefined ? null : toNumber(row.amount_cents),
    currency: row.currency ? String(row.currency) : null,
    periodBefore: nullableIso(row.period_before),
    periodAfter: nullableIso(row.period_after),
    promotionId: row.promotion_id ? String(row.promotion_id) : null,
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    reason: row.reason ? String(row.reason) : null,
    metadata: jsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

export async function listPlans(
  includeInactive = false,
  sql: SqlClient = requirePlatformSql(),
): Promise<PlanView[]> {
  const rows = await sql`
    SELECT id, code, name, price_cents, currency, billing_interval, sku_limit,
           active, sort_order, features
      FROM plans
     WHERE (${includeInactive}::boolean = TRUE OR active = TRUE)
     ORDER BY sort_order, price_cents, lower(code)
  `;
  return (rows as Row[]).map((row) =>
    toPlan({ ...row, plan_id: row.id, plan_code: row.code, plan_name: row.name, plan_active: row.active }),
  );
}

export async function getPlanByCode(
  code: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<PlanView | null> {
  const rows = await sql`
    SELECT id, code, name, price_cents, currency, billing_interval, sku_limit,
           active, sort_order, features
      FROM plans
     WHERE lower(code) = lower(${code})
     LIMIT 1
  `;
  const row = rows[0];
  return row
    ? toPlan({ ...row, plan_id: row.id, plan_code: row.code, plan_name: row.name, plan_active: row.active })
    : null;
}

export async function ensureStoreSubscription(
  storeId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<void> {
  const inserted = await sql`
    INSERT INTO store_subscriptions (store_id, plan_id, status, current_period_start, provider)
    SELECT s.id, p.id, 'free', COALESCE(s.created_at, NOW()), 'manual'
      FROM stores s
      JOIN plans p ON lower(p.code) = 'free'
     WHERE s.id = ${storeId}::uuid
    ON CONFLICT (store_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    const exists = await sql`SELECT 1 FROM store_subscriptions WHERE store_id = ${storeId}::uuid LIMIT 1`;
    if (exists.length === 0) throw new BillingError('store_not_found', 'Tienda no encontrada.', 404);
  }
}

export async function getStoreSubscriptionRow(
  storeId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<Row> {
  const select = async () =>
    (await sql`
      SELECT ss.*, s.name AS store_name,
             p.code AS plan_code, p.name AS plan_name, p.price_cents, p.currency,
             p.billing_interval, p.sku_limit, p.active AS plan_active,
             p.sort_order AS plan_sort_order, p.features,
             pp.code AS pending_plan_code, pp.name AS pending_plan_name
        FROM store_subscriptions ss
        JOIN stores s ON s.id = ss.store_id
        JOIN plans p ON p.id = ss.plan_id
        LEFT JOIN plans pp ON pp.id = ss.pending_plan_id
       WHERE ss.store_id = ${storeId}::uuid
       LIMIT 1
    `) as Row[];

  let rows = await select();
  if (rows.length === 0) {
    await ensureStoreSubscription(storeId, sql);
    rows = await select();
  }
  const row = rows[0];
  if (!row) throw new BillingError('subscription_not_found', 'La tienda no tiene suscripción.', 404);
  return row;
}

export async function getStoreSubscription(
  storeId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<StoreSubscriptionView> {
  return toSubscription(await getStoreSubscriptionRow(storeId, sql));
}

export async function listStoreSubscriptionEvents(
  storeId: string,
  limit = 30,
  sql: SqlClient = requirePlatformSql(),
): Promise<SubscriptionEventView[]> {
  const rows = await sql`
    SELECT e.id, e.event_type, fp.code AS from_plan_code, tp.code AS to_plan_code,
           e.status_from, e.status_to, e.amount_cents, e.currency,
           e.period_before, e.period_after, e.promotion_id, e.actor_user_id,
           e.reason, e.metadata, e.created_at
      FROM subscription_events e
      LEFT JOIN plans fp ON fp.id = e.from_plan_id
      LEFT JOIN plans tp ON tp.id = e.to_plan_id
     WHERE e.store_id = ${storeId}::uuid
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ${Math.min(200, Math.max(1, Math.trunc(limit)))}
  `;
  return (rows as Row[]).map(toEvent);
}

/** Snapshot completo que consume el panel del comerciante. */
export async function getStoreBillingView(
  storeId: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<StoreBillingView> {
  await ensureStoreSubscription(storeId, sql);
  const [subscriptionRow, current, plans, events] = await Promise.all([
    getStoreSubscriptionRow(storeId, sql),
    countStoreSkus(storeId, sql),
    listPlans(true, sql),
    listStoreSubscriptionEvents(storeId, 20, sql),
  ]);
  const subscription = toSubscription(subscriptionRow);
  const plan = toPlan(subscriptionRow);
  const usage = skuUsage(current, plan.skuLimit);
  const pendingPlan = subscription.pendingPlanId
    ? plans.find((item) => item.id === subscription.pendingPlanId) ?? null
    : null;

  return {
    storeId,
    storeName: String(subscriptionRow.store_name),
    plan,
    status: subscription.status,
    subscription,
    usage,
    availablePlans: plans.filter((item) => item.active),
    nextRenewalAt:
      subscription.status === 'free' || subscription.status === 'expired'
        ? null
        : subscription.currentPeriodEnd,
    pendingPlan,
    events,
  };
}

/** Para el page server de /negocio/<id>: exige owner/admin de ESA tienda. */
export async function getStoreBillingForUser(
  userId: string,
  storeId: string,
): Promise<StoreBillingView> {
  await requireStoreAccess(userId, storeId, 'admin');
  return getStoreBillingView(storeId);
}

export interface ChangePlanInput {
  storeId: string;
  planCode: string;
  effective?: 'immediate' | 'period_end';
  actorUserId?: string | null;
  reason?: string | null;
  source?: 'merchant' | 'admin' | 'provider' | 'system';
}

/** Cambio de plan. Manual/test aplica inmediato; también admite programar. */
export async function changeStorePlan(input: ChangePlanInput): Promise<StoreBillingView> {
  const sql = requirePlatformSql();
  const effective = input.effective ?? 'immediate';
  const target = await getPlanByCode(input.planCode, sql);
  if (!target || !target.active) {
    throw new BillingError('plan_not_found', 'El plan solicitado no existe o no está activo.', 404);
  }

  const subscriptionRow = await getStoreSubscriptionRow(input.storeId, sql);
  const subscription = toSubscription(subscriptionRow);
  const now = new Date();

  if (target.code === subscription.planCode) {
    // Elegir el plan actual cancela cualquier downgrade programado.
    if (subscription.pendingPlanId) {
      await sql`
        UPDATE store_subscriptions
           SET pending_plan_id = NULL, pending_plan_effective_at = NULL, updated_at = NOW()
         WHERE id = ${subscription.id}::uuid
      `;
    }
    return getStoreBillingView(input.storeId, sql);
  }

  if (!isPaidPlanCode(target.code)) {
    // Free se alcanza cancelando, no "cambiando" a un plan gratuito.
    throw new BillingError(
      'use_cancel_for_free',
      'Para volver a Free, cancela el plan de pago. Si ya venció el período, el cron lo aplica automáticamente.',
      400,
    );
  }

  const scheduleAtPeriodEnd =
    effective === 'period_end' &&
    subscription.status !== 'free' &&
    subscription.status !== 'expired' &&
    !!subscription.currentPeriodEnd &&
    new Date(subscription.currentPeriodEnd).getTime() > now.getTime();

  if (scheduleAtPeriodEnd) {
    const rows = await sql`
      WITH updated AS (
        UPDATE store_subscriptions ss
           SET pending_plan_id = ${target.id}::uuid,
               pending_plan_effective_at = ss.current_period_end,
               updated_at = NOW()
         WHERE ss.id = ${subscription.id}::uuid
         RETURNING ss.*
      ), event AS (
        INSERT INTO subscription_events (
          subscription_id, store_id, event_type, from_plan_id, to_plan_id,
          status_from, status_to, amount_cents, currency, period_before, period_after,
          actor_user_id, reason, metadata
        )
        SELECT updated.id, updated.store_id, 'plan_change_scheduled',
               ${subscription.planId}::uuid, ${target.id}::uuid,
               ${subscription.status}, ${subscription.status},
               ${target.priceCents}, ${target.currency},
               ${subscription.currentPeriodEnd}::timestamptz,
               ${subscription.currentPeriodEnd}::timestamptz,
               ${input.actorUserId ?? null}::text,
               ${input.reason ?? null}::text,
               ${JSON.stringify({ source: input.source ?? 'merchant', targetPlan: target.code })}::jsonb
          FROM updated
        RETURNING id
      )
      SELECT id FROM updated
    `;
    if (rows.length === 0) {
      throw new BillingError('subscription_not_found', 'No se pudo programar el cambio de plan.', 404);
    }
    return getStoreBillingView(input.storeId, sql);
  }

  const startingFresh =
    subscription.status === 'free' ||
    subscription.status === 'expired' ||
    !subscription.currentPeriodEnd ||
    new Date(subscription.currentPeriodEnd).getTime() <= now.getTime();

  const periodStart = startingFresh ? now : new Date(subscription.currentPeriodStart);
  const periodEnd = startingFresh ? addMonthsUtc(now, 1) : new Date(subscription.currentPeriodEnd!);
  const current = await countStoreSkus(input.storeId, sql);
  const overLimitAt = current > target.skuLimit ? now : null;
  const manualRef = `manual:${input.storeId}`;

  const rows = await sql`
    WITH updated AS (
      UPDATE store_subscriptions ss
         SET plan_id = ${target.id}::uuid,
             status = 'active',
             current_period_start = ${periodStart}::timestamptz,
             current_period_end = ${periodEnd}::timestamptz,
             cancel_at_period_end = FALSE,
             cancelled_at = NULL,
             pending_plan_id = NULL,
             pending_plan_effective_at = NULL,
             provider = ${MANUAL_PROVIDER},
             provider_customer_id = COALESCE(ss.provider_customer_id, ${manualRef}),
             provider_subscription_id = COALESCE(ss.provider_subscription_id, ${manualRef}),
             over_limit_at = ${overLimitAt}::timestamptz,
             updated_at = NOW()
       WHERE ss.id = ${subscription.id}::uuid
       RETURNING ss.*, ${subscription.planId}::uuid AS previous_plan_id,
                 ${subscription.status}::text AS previous_status,
                 ${subscription.currentPeriodEnd}::timestamptz AS previous_period_end
    ), event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, amount_cents, currency, period_before, period_after,
        actor_user_id, reason, metadata
      )
      SELECT updated.id, updated.store_id, 'plan_changed',
             updated.previous_plan_id, updated.plan_id,
             updated.previous_status, updated.status,
             ${target.priceCents}, ${target.currency},
             updated.previous_period_end, updated.current_period_end,
             ${input.actorUserId ?? null}::text,
             ${input.reason ?? null}::text,
             ${JSON.stringify({ source: input.source ?? 'merchant', targetPlan: target.code })}::jsonb
        FROM updated
      RETURNING id
    )
    SELECT id FROM updated
  `;
  if (rows.length === 0) {
    throw new BillingError('subscription_not_found', 'No se pudo cambiar el plan.', 404);
  }
  return getStoreBillingView(input.storeId, sql);
}

export interface CancelSubscriptionInput {
  storeId: string;
  immediate?: boolean;
  actorUserId?: string | null;
  reason?: string | null;
  source?: 'merchant' | 'admin' | 'provider' | 'system';
}

export async function cancelStoreSubscription(input: CancelSubscriptionInput): Promise<StoreBillingView> {
  const sql = requirePlatformSql();
  const subscriptionRow = await getStoreSubscriptionRow(input.storeId, sql);
  const subscription = toSubscription(subscriptionRow);
  const now = new Date();

  if (!isPaidPlanCode(subscription.planCode) || subscription.status === 'free') {
    throw new BillingError('not_on_paid_plan', 'La tienda ya está en el plan Free.', 400);
  }

  if (!input.immediate && subscription.cancelAtPeriodEnd) {
    return getStoreBillingView(input.storeId, sql);
  }

  if (input.immediate) {
    const free = await getPlanByCode(FREE_PLAN_CODE, sql);
    if (!free) throw new BillingError('plan_free_missing', 'No existe el plan Free.', 500);
    const current = await countStoreSkus(input.storeId, sql);
    const overLimitAt = current > free.skuLimit ? now : null;
    const rows = await sql`
      WITH updated AS (
        UPDATE store_subscriptions ss
           SET plan_id = ${free.id}::uuid,
               status = 'free',
               current_period_start = ${now}::timestamptz,
               current_period_end = NULL,
               cancel_at_period_end = FALSE,
               cancelled_at = ${now}::timestamptz,
               pending_plan_id = NULL,
               pending_plan_effective_at = NULL,
               over_limit_at = ${overLimitAt}::timestamptz,
               updated_at = NOW()
         WHERE ss.id = ${subscription.id}::uuid
         RETURNING ss.*, ${subscription.planId}::uuid AS previous_plan_id,
                   ${subscription.status}::text AS previous_status,
                   ${subscription.currentPeriodEnd}::timestamptz AS previous_period_end
      ), event AS (
        INSERT INTO subscription_events (
          subscription_id, store_id, event_type, from_plan_id, to_plan_id,
          status_from, status_to, period_before, period_after, actor_user_id, reason, metadata
        )
        SELECT updated.id, updated.store_id, 'cancelled',
               updated.previous_plan_id, updated.plan_id,
               updated.previous_status, updated.status,
               updated.previous_period_end, NULL,
               ${input.actorUserId ?? null}::text,
               ${input.reason ?? null}::text,
               ${JSON.stringify({ source: input.source ?? 'merchant', immediate: true })}::jsonb
          FROM updated
        RETURNING id
      )
      SELECT id FROM updated
    `;
    if (rows.length === 0) throw new BillingError('subscription_not_found', 'No se pudo cancelar.', 404);
    return getStoreBillingView(input.storeId, sql);
  }

  const rows = await sql`
    WITH updated AS (
      UPDATE store_subscriptions ss
         SET status = 'cancelled',
             cancel_at_period_end = TRUE,
             cancelled_at = ${now}::timestamptz,
             pending_plan_id = NULL,
             pending_plan_effective_at = NULL,
             updated_at = NOW()
       WHERE ss.id = ${subscription.id}::uuid
       RETURNING ss.*, ${subscription.planId}::uuid AS previous_plan_id,
                 ${subscription.status}::text AS previous_status
    ), event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, period_before, period_after, actor_user_id, reason, metadata
      )
      SELECT updated.id, updated.store_id, 'cancellation_scheduled',
             updated.previous_plan_id, updated.plan_id,
             updated.previous_status, updated.status,
             updated.current_period_end, updated.current_period_end,
             ${input.actorUserId ?? null}::text,
             ${input.reason ?? null}::text,
             ${JSON.stringify({ source: input.source ?? 'merchant' })}::jsonb
        FROM updated
      RETURNING id
    )
    SELECT id FROM updated
  `;
  if (rows.length === 0) throw new BillingError('subscription_not_found', 'No se pudo cancelar.', 404);
  return getStoreBillingView(input.storeId, sql);
}

/** Simula un fallo de cobro (provider manual/test). No desactiva la tienda. */
export async function markSubscriptionPaymentFailed(input: {
  storeId: string;
  reason?: string | null;
  actorUserId?: string | null;
}): Promise<StoreBillingView> {
  const sql = requirePlatformSql();
  const subscriptionRow = await getStoreSubscriptionRow(input.storeId, sql);
  const subscription = toSubscription(subscriptionRow);

  if (subscription.status === 'past_due') return getStoreBillingView(input.storeId, sql);
  if (!isPaidPlanCode(subscription.planCode) || !['active', 'trialing'].includes(subscription.status)) {
    throw new BillingError(
      'subscription_not_active',
      'Sólo una suscripción de pago activa puede pasar a past_due.',
      400,
    );
  }

  await sql`
    WITH updated AS (
      UPDATE store_subscriptions ss
         SET status = 'past_due', updated_at = NOW()
       WHERE ss.id = ${subscription.id}::uuid
       RETURNING ss.*, ${subscription.planId}::uuid AS previous_plan_id,
                 ${subscription.status}::text AS previous_status,
                 ${subscription.currentPeriodEnd}::timestamptz AS previous_period_end
    ), event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, period_before, period_after, reason, metadata, idempotency_key
      )
      SELECT updated.id, updated.store_id, 'payment_failed',
             updated.previous_plan_id, updated.plan_id,
             updated.previous_status, updated.status,
             updated.previous_period_end, updated.current_period_end,
             ${input.reason ?? 'simulated_payment_failure'}::text,
             ${JSON.stringify({ source: 'manual_test' })}::jsonb,
             'payment_failed:' || updated.id || ':' || EXTRACT(EPOCH FROM COALESCE(updated.previous_period_end, NOW()))::text
        FROM updated
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    )
    SELECT id FROM updated
  `;
  return getStoreBillingView(input.storeId, sql);
}

/**
 * Renueva UNA suscripción si corresponde. Idempotente: si el período ya está
 * en el futuro, no hace nada. También aplica un plan programado.
 */
export async function renewStoreSubscription(
  storeId: string,
  now: Date = new Date(),
): Promise<{ renewed: boolean; cancelled: boolean; reason?: string }> {
  const sql = requirePlatformSql();
  const subscriptionRow = await getStoreSubscriptionRow(storeId, sql);
  const subscription = toSubscription(subscriptionRow);

  if (subscription.status === 'free' || subscription.status === 'expired') {
    return { renewed: false, cancelled: false, reason: 'free' };
  }
  if (!subscription.currentPeriodEnd) {
    return { renewed: false, cancelled: false, reason: 'no_period' };
  }
  if (new Date(subscription.currentPeriodEnd).getTime() > now.getTime()) {
    return { renewed: false, cancelled: false, reason: 'not_due' };
  }
  if (subscription.cancelAtPeriodEnd || subscription.status === 'cancelled') {
    const cancelled = await finalizeCancellation(storeId, now);
    return { renewed: false, cancelled };
  }
  if (subscription.status === 'past_due') {
    return { renewed: false, cancelled: false, reason: 'past_due' };
  }
  if (!['active', 'trialing'].includes(subscription.status)) {
    return { renewed: false, cancelled: false, reason: 'not_renewable' };
  }
  if (subscription.provider !== MANUAL_PROVIDER) {
    // Con proveedor real, la renovación la confirma el webhook del proveedor.
    return { renewed: false, cancelled: false, reason: 'provider_managed' };
  }

  const targetPlan = await getPlanByCode(subscription.pendingPlanCode ?? subscription.planCode, sql);
  if (!targetPlan) throw new BillingError('plan_not_found', 'El plan de la suscripción no existe.', 500);
  const current = await countStoreSkus(storeId, sql);
  const overLimitAt = current > targetPlan.skuLimit ? now : null;

  const rows = await sql`
    WITH sub AS (
      SELECT ss.*, p.code AS current_plan_code
        FROM store_subscriptions ss
        JOIN plans p ON p.id = ss.plan_id
       WHERE ss.id = ${subscription.id}::uuid
       FOR UPDATE
    ), updated AS (
      UPDATE store_subscriptions ss
         SET current_period_start = sub.current_period_end,
             current_period_end = sub.current_period_end + INTERVAL '1 month',
             plan_id = COALESCE(sub.pending_plan_id, sub.plan_id),
             status = 'active',
             cancel_at_period_end = FALSE,
             cancelled_at = NULL,
             pending_plan_id = NULL,
             pending_plan_effective_at = NULL,
             over_limit_at = ${overLimitAt}::timestamptz,
             updated_at = NOW()
        FROM sub
       WHERE ss.id = sub.id
         AND sub.status IN ('active', 'trialing')
         AND sub.cancel_at_period_end = FALSE
         AND sub.current_period_end <= ${now}::timestamptz
       RETURNING ss.*, sub.current_period_end AS old_period_end,
                 sub.plan_id AS old_plan_id, sub.status AS old_status,
                 sub.pending_plan_id AS old_pending_plan_id
    ), renewal_event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, amount_cents, currency,
        period_before, period_after, metadata, idempotency_key
      )
      SELECT updated.id, updated.store_id, 'renewal',
             updated.old_plan_id, updated.plan_id,
             updated.old_status, updated.status,
             ${targetPlan.priceCents}, ${targetPlan.currency},
             updated.old_period_end, updated.current_period_end,
             ${JSON.stringify({ source: 'manual_test' })}::jsonb,
             'renewal:' || updated.id || ':' || EXTRACT(EPOCH FROM updated.old_period_end)::text
        FROM updated
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    ), plan_event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, period_before, period_after, metadata, idempotency_key
      )
      SELECT updated.id, updated.store_id, 'plan_change_applied',
             updated.old_plan_id, updated.plan_id,
             updated.old_status, updated.status,
             updated.old_period_end, updated.current_period_end,
             ${JSON.stringify({ source: 'scheduled_downgrade' })}::jsonb,
             'plan_applied:' || updated.id || ':' || EXTRACT(EPOCH FROM updated.old_period_end)::text
        FROM updated
       WHERE updated.old_pending_plan_id IS NOT NULL
         AND updated.old_pending_plan_id <> updated.old_plan_id
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    )
    SELECT id FROM updated
  `;

  if (rows.length === 0) return { renewed: false, cancelled: false, reason: 'already_processed' };
  await refreshStoreOverLimit(storeId, sql);
  return { renewed: true, cancelled: false };
}

async function finalizeCancellation(storeId: string, now: Date): Promise<boolean> {
  const sql = requirePlatformSql();
  const subscriptionRow = await getStoreSubscriptionRow(storeId, sql);
  const subscription = toSubscription(subscriptionRow);
  const free = await getPlanByCode(FREE_PLAN_CODE, sql);
  if (!free) throw new BillingError('plan_free_missing', 'No existe el plan Free.', 500);
  if (!subscription.currentPeriodEnd || new Date(subscription.currentPeriodEnd).getTime() > now.getTime()) {
    return false;
  }
  const current = await countStoreSkus(storeId, sql);
  const overLimitAt = current > free.skuLimit ? now : null;

  const rows = await sql`
    WITH updated AS (
      UPDATE store_subscriptions ss
         SET plan_id = ${free.id}::uuid,
             status = 'free',
             current_period_start = ${now}::timestamptz,
             current_period_end = NULL,
             cancel_at_period_end = FALSE,
             cancelled_at = COALESCE(ss.cancelled_at, ${now}::timestamptz),
             pending_plan_id = NULL,
             pending_plan_effective_at = NULL,
             over_limit_at = ${overLimitAt}::timestamptz,
             updated_at = NOW()
       WHERE ss.id = ${subscription.id}::uuid
         AND ss.cancel_at_period_end = TRUE
         AND ss.current_period_end <= ${now}::timestamptz
       RETURNING ss.*, ${subscription.planId}::uuid AS previous_plan_id,
                 ${subscription.status}::text AS previous_status,
                 ${subscription.currentPeriodEnd}::timestamptz AS previous_period_end
    ), event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, period_before, period_after, metadata, idempotency_key
      )
      SELECT updated.id, updated.store_id, 'cancelled',
             updated.previous_plan_id, updated.plan_id,
             updated.previous_status, updated.status,
             updated.previous_period_end, NULL,
             ${JSON.stringify({ source: 'cron' })}::jsonb,
             'cancelled:' || updated.id || ':' || EXTRACT(EPOCH FROM updated.previous_period_end)::text
        FROM updated
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    )
    SELECT id FROM updated
  `;
  if (rows.length > 0) await refreshStoreOverLimit(storeId, sql);
  return rows.length > 0;
}

/** Expira una suscripción past_due después de la gracia (no toca la tienda). */
export async function expirePastDueSubscription(storeId: string, now: Date): Promise<boolean> {
  const sql = requirePlatformSql();
  const subscriptionRow = await getStoreSubscriptionRow(storeId, sql);
  const subscription = toSubscription(subscriptionRow);
  if (subscription.status !== 'past_due') return false;
  const free = await getPlanByCode(FREE_PLAN_CODE, sql);
  if (!free) throw new BillingError('plan_free_missing', 'No existe el plan Free.', 500);
  const current = await countStoreSkus(storeId, sql);
  const overLimitAt = current > free.skuLimit ? now : null;

  const rows = await sql`
    WITH updated AS (
      UPDATE store_subscriptions ss
         SET plan_id = ${free.id}::uuid,
             status = 'free',
             current_period_start = ${now}::timestamptz,
             current_period_end = NULL,
             cancel_at_period_end = FALSE,
             pending_plan_id = NULL,
             pending_plan_effective_at = NULL,
             over_limit_at = ${overLimitAt}::timestamptz,
             updated_at = NOW()
       WHERE ss.id = ${subscription.id}::uuid
         AND ss.status = 'past_due'
       RETURNING ss.*, ${subscription.planId}::uuid AS previous_plan_id,
                 ${subscription.status}::text AS previous_status,
                 ${subscription.currentPeriodEnd}::timestamptz AS previous_period_end
    ), event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, period_before, period_after, metadata, idempotency_key
      )
      SELECT updated.id, updated.store_id, 'expired',
             updated.previous_plan_id, updated.plan_id,
             updated.previous_status, updated.status,
             updated.previous_period_end, NULL,
             ${JSON.stringify({ source: 'cron', graceExpired: true })}::jsonb,
             'expired:' || updated.id || ':' || EXTRACT(EPOCH FROM updated.previous_period_end)::text
        FROM updated
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    )
    SELECT id FROM updated
  `;
  if (rows.length > 0) await refreshStoreOverLimit(storeId, sql);
  return rows.length > 0;
}

/** Lista para /admin/planes. Incluye tiendas Free y over_limit. */
export async function listAdminSubscriptions(
  sql: SqlClient = requirePlatformSql(),
): Promise<AdminSubscriptionRow[]> {
  const rows = await sql`
    SELECT s.id AS store_id, s.name AS store_name, s.slug AS store_slug, s.active AS store_active,
           p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
           p.price_cents, p.currency, p.billing_interval, p.sku_limit,
           p.active AS plan_active, p.sort_order AS plan_sort_order, p.features,
           ss.status, ss.current_period_end, ss.cancel_at_period_end, ss.provider,
           pp.code AS pending_plan_code,
           COALESCE(u.sku_count, 0)::int AS sku_count
      FROM stores s
      JOIN store_subscriptions ss ON ss.store_id = s.id
      JOIN plans p ON p.id = ss.plan_id
      LEFT JOIN plans pp ON pp.id = ss.pending_plan_id
      LEFT JOIN store_sku_usage u ON u.store_id = s.id
     ORDER BY lower(s.name)
  `;
  return (rows as Row[]).map((row) => {
    const plan = toPlan(row);
    return {
      storeId: String(row.store_id),
      storeName: String(row.store_name),
      storeSlug: String(row.store_slug),
      storeActive: row.store_active === true,
      plan,
      status: String(row.status) as SubscriptionStatus,
      usage: skuUsage(toNumber(row.sku_count), plan.skuLimit),
      currentPeriodEnd: nullableIso(row.current_period_end),
      cancelAtPeriodEnd: row.cancel_at_period_end === true,
      pendingPlanCode: row.pending_plan_code ? String(row.pending_plan_code) : null,
      provider: String(row.provider ?? MANUAL_PROVIDER),
    };
  });
}

export async function listAdminEventsForStore(
  storeId: string,
  limit = 100,
): Promise<SubscriptionEventView[]> {
  return listStoreSubscriptionEvents(storeId, limit);
}
