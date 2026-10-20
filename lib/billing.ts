/**
 * lib/billing.ts — dominio puro de planes y suscripciones (sin DB ni Next).
 *
 * Lo que SÍ vive acá:
 *   · el catálogo canónico que usan tests, docs y UI;
 *   · los estados y sus etiquetas;
 *   · aritmética de períodos en UTC;
 *   · el error estructurado `plan_sku_limit_reached`.
 *
 * Lo que NO vive acá: SQL, sesiones, cookies, Stripe/Mercado Pago. Eso está en
 * `lib/billing/*.server.ts`.
 */

export const BILLING_CURRENCY = 'USD' as const;

export const SUBSCRIPTION_STATUSES = [
  'free',
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'expired',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  free: 'Free',
  trialing: 'Prueba',
  active: 'Activa',
  past_due: 'Pago pendiente',
  cancelled: 'Cancelada (activa hasta el final del período)',
  expired: 'Expirada',
};

/** Planes aprobados para la primera versión comercial. */
export interface PlanDefinition {
  code: string;
  name: string;
  priceCents: number;
  currency: typeof BILLING_CURRENCY;
  billingInterval: 'month';
  skuLimit: number;
  sortOrder: number;
}

export const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  { code: 'free', name: 'Free', priceCents: 0, currency: 'USD', billingInterval: 'month', skuLimit: 25, sortOrder: 0 },
  { code: 'starter', name: 'Starter', priceCents: 400, currency: 'USD', billingInterval: 'month', skuLimit: 50, sortOrder: 1 },
  { code: 'growth', name: 'Growth', priceCents: 600, currency: 'USD', billingInterval: 'month', skuLimit: 100, sortOrder: 2 },
] as const;

export const FREE_PLAN_CODE = 'free';

export interface PlanView {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year';
  skuLimit: number;
  active: boolean;
  sortOrder: number;
  features: Record<string, unknown>;
}

export interface StoreSubscriptionView {
  id: string;
  storeId: string;
  planId: string;
  planCode: string;
  planName: string;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year';
  skuLimit: number;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  pendingPlanId: string | null;
  pendingPlanCode: string | null;
  pendingPlanName: string | null;
  pendingPlanEffectiveAt: string | null;
  overLimitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkuUsageView {
  current: number;
  limit: number;
  remaining: number;
  percent: number;
  overLimit: boolean;
}

export interface StoreBillingView {
  storeId: string;
  storeName: string;
  plan: PlanView;
  status: SubscriptionStatus;
  subscription: StoreSubscriptionView;
  usage: SkuUsageView;
  availablePlans: PlanView[];
  nextRenewalAt: string | null;
  pendingPlan: PlanView | null;
  events: SubscriptionEventView[];
}

export interface SubscriptionEventView {
  id: string;
  eventType: string;
  fromPlanCode: string | null;
  toPlanCode: string | null;
  statusFrom: string | null;
  statusTo: string | null;
  amountCents: number | null;
  currency: string | null;
  periodBefore: string | null;
  periodAfter: string | null;
  promotionId: string | null;
  actorUserId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PromotionView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  benefitType: string;
  durationMonths: number;
  maxRedemptions: number | null;
  redemptionCount: number;
  planId: string | null;
  planCode: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSubscriptionRow {
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeActive: boolean;
  plan: PlanView;
  status: SubscriptionStatus;
  usage: SkuUsageView;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanCode: string | null;
  provider: string;
}

/**
 * Error de límite de SKU. La API lo serializa tal cual:
 * `{ code, plan, limit, current, requested }`.
 */
export class PlanLimitError extends Error {
  readonly code = 'plan_sku_limit_reached';
  readonly status = 409;
  readonly plan: string;
  readonly limit: number;
  readonly current: number;
  readonly requested: number;

  constructor(input: { plan: string; limit: number; current: number; requested: number }) {
    super(
      `Tu plan ${input.plan} permite ${input.limit} SKU. ` +
        `Actualmente usas ${input.current}; esta acción necesita ${input.requested} más.`,
    );
    this.name = 'PlanLimitError';
    this.plan = input.plan;
    this.limit = input.limit;
    this.current = input.current;
    this.requested = input.requested;
  }
}

/** Error de negocio de billing (código estable + status HTTP). */
export class BillingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isPaidPlanCode(code: string | null | undefined): boolean {
  return !!code && code !== FREE_PLAN_CODE;
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * ¿La tienda conserva los beneficios del plan de pago?
 * `cancelled` sí: representa cancelación programada y el período sigue vigente
 * hasta `current_period_end`. `past_due` conserva beneficios durante la gracia;
 * el cron es quien expira después.
 */
export function hasPaidAccess(status: SubscriptionStatus, periodEnd: string | null, now = new Date()): boolean {
  if (status === 'free' || status === 'expired') return false;
  if (status === 'past_due') return true;
  if (!periodEnd) return status === 'active' || status === 'trialing';
  return new Date(periodEnd).getTime() > now.getTime();
}

/** Suma meses conservando el día cuando existe (31 ene + 1 mes → 28/29 feb). */
export function addMonthsUtc(value: Date | string, months: number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const day = date.getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + Math.trunc(months));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export function skuUsage(current: number, limit: number): SkuUsageView {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const safeCurrent = Math.max(0, Math.trunc(current));
  return {
    current: safeCurrent,
    limit: safeLimit,
    remaining: Math.max(0, safeLimit - safeCurrent),
    percent: Math.min(100, Math.round((safeCurrent / safeLimit) * 100)),
    overLimit: safeCurrent > safeLimit,
  };
}

/** Formato USD sin depender de Intl en tests: US$4.00 / US$0.00. */
export function formatUsdCents(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const sign = safe < 0 ? '-' : '';
  const absolute = Math.abs(safe);
  const units = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}US$${units}.${fraction}`;
}

/** Etiqueta corta para UI: "18 / 25 SKU utilizados". */
export function formatSkuUsage(current: number, limit: number): string {
  return `${current} / ${limit} SKU utilizados`;
}
