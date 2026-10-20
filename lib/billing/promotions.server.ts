/**
 * lib/billing/promotions.server.ts — meses gratis.
 *
 * Reglas de esta fase:
 *   · Un código sólo aplica a una tienda que YA tiene un plan de pago.
 *   · Free no se auto-upgradea: nunca inventamos un plan de pago.
 *   · `plan_id` opcional en la promoción restringe el plan elegible.
 *   · Un mismo código no se puede canjear dos veces por la misma tienda.
 *   · Toda aplicación extiende `current_period_end` y deja evento/redención.
 */

import {
  BillingError,
  FREE_PLAN_CODE,
  addMonthsUtc,
  isPaidPlanCode,
  type PromotionView,
  type StoreBillingView,
} from '@/lib/billing';
import type { Row, SqlClient } from '@/lib/db-driver.server';
import { requirePlatformSql, toIsoString, toNumber } from '@/lib/platform-db.server';
import { requireStoreAccess } from '@/lib/stores.server';
import { countStoreSkus, refreshStoreOverLimit } from './sku.server';
import { getPlanByCode, getStoreBillingView, getStoreSubscription } from './subscriptions.server';

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return toIsoString(value);
}

function toPromotion(row: Row): PromotionView {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    active: row.active === true,
    benefitType: String(row.benefit_type ?? 'free_months'),
    durationMonths: toNumber(row.duration_months),
    maxRedemptions: row.max_redemptions === null || row.max_redemptions === undefined
      ? null
      : toNumber(row.max_redemptions),
    redemptionCount: toNumber(row.redemption_count),
    planId: row.plan_id ? String(row.plan_id) : null,
    planCode: row.plan_code ? String(row.plan_code) : null,
    startsAt: nullableIso(row.starts_at),
    endsAt: nullableIso(row.ends_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function listPromotions(sql: SqlClient = requirePlatformSql()): Promise<PromotionView[]> {
  const rows = await sql`
    SELECT p.*, pl.code AS plan_code,
           (SELECT COUNT(*)::int FROM promotion_redemptions r WHERE r.promotion_id = p.id) AS redemption_count
      FROM promotions p
      LEFT JOIN plans pl ON pl.id = p.plan_id
     ORDER BY p.active DESC, p.created_at DESC
  `;
  return (rows as Row[]).map(toPromotion);
}

export async function getPromotionByCode(
  code: string,
  sql: SqlClient = requirePlatformSql(),
): Promise<PromotionView | null> {
  const rows = await sql`
    SELECT p.*, pl.code AS plan_code,
           (SELECT COUNT(*)::int FROM promotion_redemptions r WHERE r.promotion_id = p.id) AS redemption_count
      FROM promotions p
      LEFT JOIN plans pl ON pl.id = p.plan_id
     WHERE upper(p.code) = upper(${code})
     LIMIT 1
  `;
  const row = rows[0];
  return row ? toPromotion(row) : null;
}

export interface CreatePromotionInput {
  code: string;
  name: string;
  description?: string | null;
  active?: boolean;
  durationMonths?: number;
  maxRedemptions?: number | null;
  planCode?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  createdByUserId?: string | null;
}

export async function createPromotion(input: CreatePromotionInput): Promise<PromotionView> {
  const sql = requirePlatformSql();
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(code)) {
    throw new BillingError(
      'invalid_promotion_code',
      'El código debe tener 3–40 caracteres: letras, números, guion o guion bajo.',
      400,
    );
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new BillingError('invalid_promotion', 'El nombre de la promoción es obligatorio.', 400);
  }
  const durationMonths = Math.trunc(input.durationMonths ?? 1);
  if (durationMonths < 1 || durationMonths > 24) {
    throw new BillingError('invalid_promotion', 'durationMonths debe estar entre 1 y 24.', 400);
  }
  const maxRedemptions = input.maxRedemptions ?? null;
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
    throw new BillingError('invalid_promotion', 'maxRedemptions debe ser un entero positivo.', 400);
  }

  let planId: string | null = null;
  if (input.planCode) {
    const plan = await getPlanByCode(input.planCode, sql);
    if (!plan || !plan.active) {
      throw new BillingError('plan_not_found', 'El plan de la promoción no existe.', 404);
    }
    if (!isPaidPlanCode(plan.code)) {
      throw new BillingError('invalid_promotion', 'Una promoción no puede apuntar al plan Free.', 400);
    }
    planId = plan.id;
  }

  try {
    const rows = await sql`
      INSERT INTO promotions (
        code, name, description, active, benefit_type, duration_months,
        max_redemptions, plan_id, starts_at, ends_at, created_by_user_id
      ) VALUES (
        ${code}, ${name}, ${input.description?.trim() || null}, ${input.active !== false},
        'free_months', ${durationMonths}, ${maxRedemptions}::int, ${planId}::uuid,
        ${input.startsAt ?? null}::timestamptz, ${input.endsAt ?? null}::timestamptz,
        ${input.createdByUserId ?? null}::text
      )
      RETURNING *
    `;
    const row = rows[0] as Row | undefined;
    if (!row) throw new BillingError('promotion_create_failed', 'No se pudo crear la promoción.', 500);
    return toPromotion({ ...row, redemption_count: 0 });
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      throw new BillingError('promotion_code_taken', 'Ya existe un código con ese nombre.', 409);
    }
    throw error;
  }
}

export async function setPromotionActive(id: string, active: boolean): Promise<PromotionView> {
  const sql = requirePlatformSql();
  const rows = await sql`
    UPDATE promotions
       SET active = ${active}, updated_at = NOW()
     WHERE id = ${id}::uuid
     RETURNING *
  `;
  const row = rows[0] as Row | undefined;
  if (!row) throw new BillingError('promotion_not_found', 'Promoción no encontrada.', 404);
  const countRows = await sql`
    SELECT COUNT(*)::int AS redemption_count
      FROM promotion_redemptions
     WHERE promotion_id = ${id}::uuid
  `;
  return toPromotion({ ...row, redemption_count: toNumber(countRows[0]?.redemption_count) });
}

interface RedeemInput {
  storeId: string;
  code: string;
  actorUserId?: string | null;
  source?: 'merchant' | 'admin' | 'seed';
}

/** Canje desde el panel del comerciante (exige owner/admin de la tienda). */
export async function redeemPromotionForUser(
  userId: string,
  storeId: string,
  code: string,
): Promise<StoreBillingView> {
  await requireStoreAccess(userId, storeId, 'admin');
  return redeemPromotion({ storeId, code, actorUserId: userId, source: 'merchant' });
}

/**
 * Canje interno. La validación es explícita para devolver códigos estables; la
 * escritura atómica vuelve a comprobar duplicado/máximo contra carreras.
 */
export async function redeemPromotion(input: RedeemInput): Promise<StoreBillingView> {
  const sql = requirePlatformSql();
  const promotion = await getPromotionByCode(input.code, sql);
  if (!promotion) throw new BillingError('promotion_not_found', 'Código promocional inválido.', 404);

  const subscription = await getStoreSubscription(input.storeId, sql);
  if (!isPaidPlanCode(subscription.planCode) || subscription.status === 'free') {
    throw new BillingError(
      'promotion_requires_paid_plan',
      'El mes gratis aplica a un plan de pago. Primero elige Starter o Growth.',
      409,
    );
  }
  if (!['active', 'trialing'].includes(subscription.status)) {
    throw new BillingError(
      'subscription_not_active',
      'La suscripción debe estar activa para canjear el mes gratis.',
      409,
    );
  }
  if (promotion.planId && promotion.planId !== subscription.planId) {
    throw new BillingError(
      'promotion_plan_mismatch',
      `Este código aplica al plan ${promotion.planCode ?? 'indicado'}, no al plan actual.`,
      409,
    );
  }

  const now = new Date();
  if (!promotion.active) {
    throw new BillingError('promotion_inactive', 'Este código ya no está activo.', 409);
  }
  if (promotion.startsAt && new Date(promotion.startsAt).getTime() > now.getTime()) {
    throw new BillingError('promotion_not_started', 'Este código todavía no está vigente.', 409);
  }
  if (promotion.endsAt && new Date(promotion.endsAt).getTime() <= now.getTime()) {
    throw new BillingError('promotion_expired', 'Este código ya venció.', 409);
  }
  if (promotion.maxRedemptions !== null && promotion.redemptionCount >= promotion.maxRedemptions) {
    throw new BillingError('promotion_max_redemptions', 'Este código alcanzó su límite de canjes.', 409);
  }

  const duplicate = await sql`
    SELECT 1 FROM promotion_redemptions
     WHERE promotion_id = ${promotion.id}::uuid AND store_id = ${input.storeId}::uuid
     LIMIT 1
  `;
  if (duplicate.length > 0) {
    throw new BillingError('promotion_already_redeemed', 'Ya canjeaste este código en esta tienda.', 409);
  }

  try {
    const rows = await sql`
      WITH updated AS (
        UPDATE store_subscriptions ss
           SET current_period_end =
                 GREATEST(COALESCE(ss.current_period_end, NOW()), NOW())
                 + make_interval(months => ${promotion.durationMonths}::int),
               updated_at = NOW()
         WHERE ss.id = ${subscription.id}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM promotion_redemptions r
              WHERE r.promotion_id = ${promotion.id}::uuid
                AND r.store_id = ${input.storeId}::uuid
           )
           AND (
             ${promotion.maxRedemptions}::int IS NULL
             OR (SELECT COUNT(*) FROM promotion_redemptions r2 WHERE r2.promotion_id = ${promotion.id}::uuid)
                < ${promotion.maxRedemptions}::int
           )
         RETURNING ss.*, ${subscription.currentPeriodEnd}::timestamptz AS period_before
      ), redemption AS (
        INSERT INTO promotion_redemptions (
          promotion_id, store_id, subscription_id, period_before, period_after,
          granted_by_user_id, metadata
        )
        SELECT ${promotion.id}::uuid, updated.store_id, updated.id,
               updated.period_before, updated.current_period_end,
               ${input.actorUserId ?? null}::text,
               ${JSON.stringify({ source: input.source ?? 'merchant', code: promotion.code })}::jsonb
          FROM updated
        RETURNING id
      ), event AS (
        INSERT INTO subscription_events (
          subscription_id, store_id, event_type, from_plan_id, to_plan_id,
          status_from, status_to, period_before, period_after,
          promotion_id, actor_user_id, reason, metadata
        )
        SELECT updated.id, updated.store_id, 'promotion_redeemed',
               updated.plan_id, updated.plan_id,
               updated.status, updated.status,
               updated.period_before, updated.current_period_end,
               ${promotion.id}::uuid, ${input.actorUserId ?? null}::text,
               ${promotion.code}::text,
               ${JSON.stringify({ code: promotion.code, months: promotion.durationMonths })}::jsonb
          FROM updated
        RETURNING id
      )
      SELECT id FROM updated
    `;
    if (rows.length === 0) {
      throw new BillingError('promotion_already_redeemed', 'Ya canjeaste este código en esta tienda.', 409);
    }
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      throw new BillingError('promotion_already_redeemed', 'Ya canjeaste este código en esta tienda.', 409);
    }
    throw error;
  }

  return getStoreBillingView(input.storeId, sql);
}

/** Grant manual de Platform Admin: +N meses sin código. */
export async function grantFreeMonths(input: {
  storeId: string;
  months?: number;
  actorUserId?: string | null;
  reason?: string | null;
}): Promise<StoreBillingView> {
  const sql = requirePlatformSql();
  const months = Math.trunc(input.months ?? 1);
  if (months < 1 || months > 24) {
    throw new BillingError('invalid_grant', 'months debe estar entre 1 y 24.', 400);
  }

  const subscription = await getStoreSubscription(input.storeId, sql);
  if (!isPaidPlanCode(subscription.planCode) || subscription.status === 'free') {
    throw new BillingError(
      'promotion_requires_paid_plan',
      'El mes gratis aplica a un plan de pago. La tienda está en Free.',
      409,
    );
  }
  if (!['active', 'trialing'].includes(subscription.status)) {
    throw new BillingError(
      'subscription_not_active',
      'La suscripción debe estar activa para otorgar el mes gratis.',
      409,
    );
  }

  const rows = await sql`
    WITH updated AS (
      UPDATE store_subscriptions ss
         SET current_period_end =
               GREATEST(COALESCE(ss.current_period_end, NOW()), NOW())
               + make_interval(months => ${months}::int),
             updated_at = NOW()
       WHERE ss.id = ${subscription.id}::uuid
       RETURNING ss.*, ${subscription.currentPeriodEnd}::timestamptz AS period_before
    ), event AS (
      INSERT INTO subscription_events (
        subscription_id, store_id, event_type, from_plan_id, to_plan_id,
        status_from, status_to, period_before, period_after,
        actor_user_id, reason, metadata
      )
      SELECT updated.id, updated.store_id, 'admin_grant',
             updated.plan_id, updated.plan_id,
             updated.status, updated.status,
             updated.period_before, updated.current_period_end,
             ${input.actorUserId ?? null}::text,
             ${input.reason ?? 'grant_manual'}::text,
             ${JSON.stringify({ months, source: 'platform_admin' })}::jsonb
        FROM updated
      RETURNING id
    )
    SELECT id FROM updated
  `;
  if (rows.length === 0) throw new BillingError('grant_failed', 'No se pudo otorgar el mes gratis.', 500);
  return getStoreBillingView(input.storeId, sql);
}

/**
 * Helper para el seed de staging. Aplica un plan de pago sin eventos si ya está
 * en ese plan; si no, usa el cambio normal (y por tanto deja historial).
 */
export async function seedStorePlan(
  storeId: string,
  planCode: string,
  options: { provider?: string } = {},
): Promise<void> {
  const sql = requirePlatformSql();
  const plan = await getPlanByCode(planCode, sql);
  if (!plan) throw new BillingError('plan_not_found', `Plan ${planCode} no existe.`, 404);
  const subscription = await getStoreSubscription(storeId, sql);
  if (subscription.planCode === plan.code && subscription.status === 'active') {
    return;
  }
  if (!isPaidPlanCode(plan.code)) {
    await sql`
      UPDATE store_subscriptions
         SET plan_id = ${plan.id}::uuid, status = 'free',
             current_period_start = NOW(), current_period_end = NULL,
             cancel_at_period_end = FALSE, cancelled_at = NULL,
             pending_plan_id = NULL, pending_plan_effective_at = NULL,
             provider = ${options.provider ?? 'manual'},
             over_limit_at = CASE
               WHEN COALESCE((SELECT sku_count FROM store_sku_usage WHERE store_id = ${storeId}::uuid), 0) > ${plan.skuLimit}
                 THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE store_id = ${storeId}::uuid
    `;
    return;
  }
  const now = new Date();
  const end = addMonthsUtc(now, 1);
  const current = await countStoreSkus(storeId, sql);
  await sql`
    UPDATE store_subscriptions
       SET plan_id = ${plan.id}::uuid,
           status = 'active',
           current_period_start = ${now}::timestamptz,
           current_period_end = ${end}::timestamptz,
           cancel_at_period_end = FALSE,
           cancelled_at = NULL,
           pending_plan_id = NULL,
           pending_plan_effective_at = NULL,
           provider = ${options.provider ?? 'manual'},
           provider_customer_id = COALESCE(provider_customer_id, ${`manual:${storeId}`}),
           provider_subscription_id = COALESCE(provider_subscription_id, ${`manual:${storeId}`}),
           over_limit_at = ${current > plan.skuLimit ? now : null}::timestamptz,
           updated_at = NOW()
     WHERE store_id = ${storeId}::uuid
  `;
  await refreshStoreOverLimit(storeId, sql);
}

/** Sólo para scripts/tests: evita importar el plan Free desde otro lado. */
export { FREE_PLAN_CODE };
