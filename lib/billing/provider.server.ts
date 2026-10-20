/**
 * lib/billing/provider.server.ts — contrato de cobro recurrente de PLANES.
 *
 * Es deliberadamente independiente del Mercado Pago de PEDIDOS. El código de
 * `mp-orders`, Preferences y webhooks de pedidos NO se reutiliza acá.
 *
 * En esta fase sólo existe `manual` (test/staging):
 *   · no cobra dinero;
 *   · permite demostrar upgrades, downgrades, renovaciones y fallos;
 *   · registra todo en `subscription_events`.
 *
 * Un proveedor real futuro (Mercado Pago Suscripciones, Stripe, Paddle, etc.)
 * debe implementar esta interfaz. Mientras no exista, elegir otro valor falla
 * cerrado.
 */

import {
  BillingError,
  type StoreBillingView,
  type StoreSubscriptionView,
} from '@/lib/billing';
import {
  cancelStoreSubscription,
  changeStorePlan,
  getStoreSubscription,
  markSubscriptionPaymentFailed,
  renewStoreSubscription,
} from './subscriptions.server';

export interface CreateSubscriptionInput {
  storeId: string;
  planCode: string;
  actorUserId?: string | null;
  reason?: string | null;
}

export interface CancelSubscriptionInput {
  storeId: string;
  immediate?: boolean;
  actorUserId?: string | null;
  reason?: string | null;
}

export interface ChangePlanInput {
  storeId: string;
  planCode: string;
  effective?: 'immediate' | 'period_end';
  actorUserId?: string | null;
  reason?: string | null;
}

export type BillingWebhookPayload =
  | { type: 'payment_failed'; storeId: string; reason?: string | null }
  | { type: 'renewal'; storeId: string }
  | { type: 'cancelled'; storeId: string; immediate?: boolean };

export interface BillingProvider {
  readonly code: string;
  createSubscription(input: CreateSubscriptionInput): Promise<StoreBillingView>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<StoreBillingView>;
  changePlan(input: ChangePlanInput): Promise<StoreBillingView>;
  getSubscription(storeId: string): Promise<StoreSubscriptionView>;
  processWebhook(payload: BillingWebhookPayload): Promise<{ handled: boolean; reason?: string }>;
}

class ManualBillingProvider implements BillingProvider {
  readonly code = 'manual';

  async createSubscription(input: CreateSubscriptionInput): Promise<StoreBillingView> {
    if (input.planCode.toLowerCase() === 'free') {
      throw new BillingError('invalid_provider_plan', 'Free no requiere suscripción de pago.', 400);
    }
    return changeStorePlan({
      storeId: input.storeId,
      planCode: input.planCode,
      effective: 'immediate',
      actorUserId: input.actorUserId ?? null,
      reason: input.reason ?? 'manual_provider_create',
      source: 'provider',
    });
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<StoreBillingView> {
    return cancelStoreSubscription({
      storeId: input.storeId,
      immediate: input.immediate,
      actorUserId: input.actorUserId ?? null,
      reason: input.reason ?? 'manual_provider_cancel',
      source: 'provider',
    });
  }

  async changePlan(input: ChangePlanInput): Promise<StoreBillingView> {
    return changeStorePlan({
      storeId: input.storeId,
      planCode: input.planCode,
      effective: input.effective ?? 'immediate',
      actorUserId: input.actorUserId ?? null,
      reason: input.reason ?? 'manual_provider_change',
      source: 'provider',
    });
  }

  async getSubscription(storeId: string): Promise<StoreSubscriptionView> {
    return getStoreSubscription(storeId);
  }

  async processWebhook(payload: BillingWebhookPayload): Promise<{ handled: boolean; reason?: string }> {
    if (payload.type === 'payment_failed') {
      await markSubscriptionPaymentFailed({
        storeId: payload.storeId,
        reason: payload.reason ?? 'manual_webhook_payment_failed',
      });
      return { handled: true };
    }
    if (payload.type === 'cancelled') {
      await cancelStoreSubscription({
        storeId: payload.storeId,
        immediate: payload.immediate === true,
        reason: 'manual_webhook_cancelled',
        source: 'provider',
      });
      return { handled: true };
    }
    if (payload.type === 'renewal') {
      const result = await renewStoreSubscription(payload.storeId);
      return { handled: result.renewed || result.cancelled, reason: result.reason };
    }
    return { handled: false, reason: 'unsupported_event' };
  }
}

const manualProvider = new ManualBillingProvider();

/** `manual`/`test` son alias; cualquier otro valor falla cerrado. */
export function getBillingProvider(code?: string | null): BillingProvider {
  const requested = (code ?? process.env.BILLING_PROVIDER ?? 'manual').trim().toLowerCase();
  if (!requested || requested === 'manual' || requested === 'test') return manualProvider;
  throw new BillingError(
    'billing_provider_not_implemented',
    `El proveedor de billing "${requested}" no está implementado. Esta fase sólo habilita manual/test.`,
    503,
  );
}
