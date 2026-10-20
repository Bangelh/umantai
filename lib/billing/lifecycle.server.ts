/**
 * lib/billing/lifecycle.server.ts — job idempotente de billing.
 *
 * Separado a propósito del cron de reservas de pedidos. Este job:
 *   · renueva suscripciones manuales cuyo período venció;
 *   · aplica cancelaciones al final del período;
 *   · expira past_due después de la gracia configurable.
 *
 * No toca pedidos, stock, Mercado Pago ni la visibilidad de la tienda.
 */

import { requirePlatformSql } from '@/lib/platform-db.server';
import type { Row } from '@/lib/db-driver.server';
import { expirePastDueSubscription, renewStoreSubscription } from './subscriptions.server';

export interface BillingCycleResult {
  now: string;
  graceDays: number;
  scanned: number;
  renewed: number;
  cancelled: number;
  expired: number;
  failed: number;
  errors: Array<{ storeId: string; error: string }>;
}

/** Días de gracia para past_due. Default 3; se puede ajustar por entorno. */
export function getBillingGraceDays(): number {
  const parsed = Number(process.env.BILLING_GRACE_DAYS);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 0), 30);
}

async function listDueStoreIds(now: Date, limit: number): Promise<string[]> {
  const sql = requirePlatformSql();
  const rows = await sql`
    SELECT store_id
      FROM store_subscriptions
     WHERE provider = 'manual'
       AND current_period_end IS NOT NULL
       AND current_period_end <= ${now}::timestamptz
       AND status IN ('active', 'trialing', 'cancelled')
     ORDER BY current_period_end ASC
     LIMIT ${Math.min(500, Math.max(1, Math.trunc(limit)))}
  `;
  return (rows as Row[]).map((row) => String(row.store_id));
}

async function listExpiredGraceStoreIds(
  now: Date,
  graceDays: number,
  limit: number,
): Promise<string[]> {
  const sql = requirePlatformSql();
  const rows = await sql`
    SELECT store_id
      FROM store_subscriptions
     WHERE status = 'past_due'
       AND current_period_end IS NOT NULL
       AND current_period_end <= ${now}::timestamptz - make_interval(days => ${graceDays}::int)
     ORDER BY current_period_end ASC
     LIMIT ${Math.min(500, Math.max(1, Math.trunc(limit)))}
  `;
  return (rows as Row[]).map((row) => String(row.store_id));
}

/**
 * Ejecuta un ciclo. Es seguro llamarlo dos veces: cada transición comprueba
 * `current_period_end <= now` y los eventos tienen `idempotency_key` única.
 */
export async function runBillingCycle(input: {
  now?: Date;
  limit?: number;
} = {}): Promise<BillingCycleResult> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 200;
  const graceDays = getBillingGraceDays();
  const result: BillingCycleResult = {
    now: now.toISOString(),
    graceDays,
    scanned: 0,
    renewed: 0,
    cancelled: 0,
    expired: 0,
    failed: 0,
    errors: [],
  };

  const due = await listDueStoreIds(now, limit);
  result.scanned = due.length;
  for (const storeId of due) {
    try {
      const outcome = await renewStoreSubscription(storeId, now);
      if (outcome.renewed) result.renewed += 1;
      if (outcome.cancelled) result.cancelled += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        storeId,
        error: error instanceof Error ? error.message : 'billing_renewal_failed',
      });
    }
  }

  const expired = await listExpiredGraceStoreIds(now, graceDays, limit);
  for (const storeId of expired) {
    try {
      if (await expirePastDueSubscription(storeId, now)) result.expired += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        storeId,
        error: error instanceof Error ? error.message : 'billing_expire_failed',
      });
    }
  }

  return result;
}
