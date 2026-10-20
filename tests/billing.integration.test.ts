/**
 * tests/billing.integration.test.ts — PostgreSQL REAL (efímero, local).
 *
 * Cubre los mínimos de PLANS + SUBSCRIPTIONS:
 *   · Free automática y catálogo 25/50/100.
 *   · SKU: simple, variantes, draft, archivado, límite exacto, +1 y over_limit.
 *   · Upgrade, downgrade programado, cancelación, renovación idempotente,
 *     past_due y expiración.
 *   · Promociones +1 mes: canje, duplicado, vencida, inactiva, máximo,
 *     plan equivocado, Free rechazado y grant admin.
 *   · Aislamiento: merchant B no lee billing de A.
 *
 * Nunca lee DATABASE_URL ni toca staging/Producción.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDbPools } from '../lib/db-driver.server';
import { startTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-postgres';
import { PlanLimitError, BillingError } from '../lib/billing';
import { TenancyError } from '../lib/tenancy';

type Stores = typeof import('../lib/stores.server');
type Catalog = typeof import('../lib/store-catalog.server');
type Platform = typeof import('../lib/platform-db.server');
type Subscriptions = typeof import('../lib/billing/subscriptions.server');
type Promotions = typeof import('../lib/billing/promotions.server');
type Lifecycle = typeof import('../lib/billing/lifecycle.server');

let database: EmbeddedTestDatabase;
let stores: Stores;
let catalog: Catalog;
let platform: Platform;
let subscriptions: Subscriptions;
let promotions: Promotions;
let lifecycle: Lifecycle;

const PASSWORDLESS_OWNER = (label: string) => `billing-${label}-${randomUUID()}@example.test`;

before(async () => {
  database = await startTestDatabase();

  process.env.DB_DRIVER = 'pg';
  process.env.POSTGRES_URL_NON_POOLING = database.url;
  process.env.APP_ENV = 'test';
  process.env.BILLING_PROVIDER = 'manual';
  process.env.BILLING_GRACE_DAYS = '3';
  delete process.env.VERCEL_ENV;

  stores = await import('../lib/stores.server');
  catalog = await import('../lib/store-catalog.server');
  platform = await import('../lib/platform-db.server');
  subscriptions = await import('../lib/billing/subscriptions.server');
  promotions = await import('../lib/billing/promotions.server');
  lifecycle = await import('../lib/billing/lifecycle.server');
});

after(async () => {
  await closeDbPools();
  if (database) await database.stop();
});

function sql() {
  return platform.requirePlatformSql();
}

async function createOwner(label: string): Promise<string> {
  const id = `u_${randomUUID()}`;
  await sql()`
    INSERT INTO users (id, name, email)
    VALUES (${id}, ${`Billing ${label}`}, ${PASSWORDLESS_OWNER(label)})
  `;
  return id;
}

async function createStore(label: string, ownerId: string): Promise<string> {
  const created = await stores.createStoreForOwner({
    ownerUserId: ownerId,
    name: `Tienda ${label} ${randomUUID().slice(0, 6)}`,
    slug: `billing-${label}-${randomUUID().slice(0, 8)}`,
    latitude: -12.04,
    longitude: -77.03,
  });
  return created.id;
}

async function createProduct(
  ownerId: string,
  storeId: string,
  name: string,
  options: { visible?: boolean; variants?: Array<{ options: Record<string, string>; active?: boolean }> } = {},
) {
  return catalog.createStoreProductCatalog(ownerId, storeId, {
    name,
    priceCents: 1000,
    visible: options.visible ?? true,
    variants: (options.variants ?? []).map((variant, index) => ({
      optionValues: variant.options,
      sku: `SKU-${name}-${index}`.toUpperCase().replace(/\s+/g, '-'),
      initialStock: 0,
      active: variant.active !== false,
    })),
  });
}

async function usage(storeId: string): Promise<number> {
  return subscriptions.getStoreBillingView(storeId).then((billing) => billing.usage.current);
}

async function forcePeriodEnd(storeId: string, iso: string): Promise<void> {
  await sql()`
    UPDATE store_subscriptions
       SET current_period_start = ${iso}::timestamptz - INTERVAL '1 day',
           current_period_end = ${iso}::timestamptz
     WHERE store_id = ${storeId}::uuid
  `;
}

async function eventTypes(storeId: string): Promise<string[]> {
  const rows = await sql()`
    SELECT event_type FROM subscription_events
     WHERE store_id = ${storeId}::uuid
     ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => String(row.event_type));
}

// =============================================================================
//  PLANES + FREE AUTOMÁTICA
// =============================================================================

test('toda tienda nueva recibe Free 25 explícito, sin método de pago', async () => {
  const ownerId = await createOwner('free');
  const storeId = await createStore('free', ownerId);
  const billing = await subscriptions.getStoreBillingView(storeId);

  assert.equal(billing.plan.code, 'free');
  assert.equal(billing.status, 'free');
  assert.equal(billing.usage.limit, 25);
  assert.equal(billing.usage.current, 0);
  assert.equal(billing.subscription.cancelAtPeriodEnd, false);
  assert.ok(billing.subscription.id, 'debe existir una fila de suscripción');
  assert.ok((await eventTypes(storeId)).includes('subscription_created'));

  const plans = await subscriptions.listPlans();
  assert.deepEqual(
    plans.map((plan) => [plan.code, plan.skuLimit, plan.priceCents]),
    [
      ['free', 25, 0],
      ['starter', 50, 400],
      ['growth', 100, 600],
    ],
  );
});

test('SKU: simple 1, variantes individuales, draft 0, archivados no cuentan', async () => {
  const ownerId = await createOwner('sku-rules');
  const storeId = await createStore('sku-rules', ownerId);

  const draft = await createProduct(ownerId, storeId, 'Borrador', {
    visible: false,
    variants: [
      { options: { talla: 'S' } },
      { options: { talla: 'M' } },
      { options: { talla: 'L' } },
    ],
  });
  assert.equal(await usage(storeId), 0);

  await catalog.updateStoreProductCatalog(ownerId, storeId, String(draft.id), { visible: true });
  assert.equal(await usage(storeId), 3);

  const added = await catalog.addStoreVariant(ownerId, storeId, String(draft.id), {
    optionValues: { talla: 'XL' },
    sku: 'XL-1',
    initialStock: 0,
  });
  assert.equal(await usage(storeId), 4);

  await catalog.updateStoreVariant(ownerId, storeId, String(draft.id), String(added.id), { archived: true });
  assert.equal(await usage(storeId), 3);

  await catalog.updateStoreProductCatalog(ownerId, storeId, String(draft.id), { archived: true });
  assert.equal(await usage(storeId), 0);

  // Primera variante de un producto simple: reemplaza el SKU base, no suma.
  const simple = await createProduct(ownerId, storeId, 'Simple');
  assert.equal(await usage(storeId), 1);
  await catalog.addStoreVariant(ownerId, storeId, String(simple.id), {
    optionValues: { color: 'negro' },
    sku: 'NEGRO-1',
    initialStock: 0,
  });
  assert.equal(await usage(storeId), 1);
});

test('límite exacto 25 permitido, 26 rechazado, upgrade a 50 y Growth 100', async () => {
  const ownerId = await createOwner('limit');
  const storeId = await createStore('limit', ownerId);

  for (let index = 1; index <= 25; index += 1) {
    await createProduct(ownerId, storeId, `Free ${index}`);
  }
  assert.equal(await usage(storeId), 25);

  await assert.rejects(
    () => createProduct(ownerId, storeId, 'Free 26'),
    (error: unknown) => {
      assert.ok(error instanceof PlanLimitError);
      assert.equal(error.code, 'plan_sku_limit_reached');
      assert.equal(error.plan, 'free');
      assert.equal(error.limit, 25);
      assert.equal(error.current, 25);
      assert.equal(error.requested, 1);
      return true;
    },
  );
  assert.equal(await usage(storeId), 25, 'el rechazo no escribe el producto 26');

  await subscriptions.changeStorePlan({ storeId, planCode: 'starter', reason: 'test_upgrade' });
  await createProduct(ownerId, storeId, 'Starter 26');
  for (let index = 27; index <= 50; index += 1) {
    await createProduct(ownerId, storeId, `Starter ${index}`);
  }
  assert.equal(await usage(storeId), 50);

  await assert.rejects(
    () => createProduct(ownerId, storeId, 'Starter 51'),
    (error: unknown) => error instanceof PlanLimitError && error.plan === 'starter' && error.limit === 50,
  );

  await subscriptions.changeStorePlan({ storeId, planCode: 'growth', reason: 'test_growth' });
  await createProduct(ownerId, storeId, 'Growth 51');
  assert.equal(await usage(storeId), 51);

  const downgraded = await subscriptions.changeStorePlan({
    storeId,
    planCode: 'starter',
    effective: 'immediate',
    reason: 'test_downgrade',
  });
  assert.equal(downgraded.plan.code, 'starter');
  assert.equal(downgraded.usage.overLimit, true);
  assert.ok(downgraded.subscription.overLimitAt, 'over_limit debe quedar marcado');

  await assert.rejects(
    () => createProduct(ownerId, storeId, 'Bloqueado por over_limit'),
    (error: unknown) => error instanceof PlanLimitError,
  );

  const visible = await sql()`
    SELECT COUNT(*)::int AS count FROM store_products
     WHERE store_id = ${storeId}::uuid AND visible = TRUE AND archived_at IS NULL
  `;
  assert.equal(Number(visible[0]?.count), 51, 'los productos ya publicados permanecen visibles');
});

// =============================================================================
//  CICLO DE SUSCRIPCIÓN
// =============================================================================

test('upgrade, cancelación al final, renovación idempotente y Free', async () => {
  const ownerId = await createOwner('lifecycle');
  const storeId = await createStore('lifecycle', ownerId);

  const upgraded = await subscriptions.changeStorePlan({
    storeId,
    planCode: 'starter',
    reason: 'test_start',
  });
  assert.equal(upgraded.plan.code, 'starter');
  assert.equal(upgraded.status, 'active');
  assert.ok(upgraded.subscription.currentPeriodEnd);
  assert.ok((await eventTypes(storeId)).includes('plan_changed'));

  const cancelled = await subscriptions.cancelStoreSubscription({ storeId, reason: 'test_cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.plan.code, 'starter');
  assert.equal(cancelled.subscription.cancelAtPeriodEnd, true);
  assert.ok((await eventTypes(storeId)).includes('cancellation_scheduled'));

  await forcePeriodEnd(storeId, new Date(Date.now() - 60_000).toISOString());
  const finalized = await subscriptions.renewStoreSubscription(storeId);
  assert.equal(finalized.cancelled, true);

  const free = await subscriptions.getStoreBillingView(storeId);
  assert.equal(free.plan.code, 'free');
  assert.equal(free.status, 'free');
  assert.ok((await eventTypes(storeId)).includes('cancelled'));
});

test('renovación manual extiende una sola vez y no duplica eventos', async () => {
  const ownerId = await createOwner('renew');
  const storeId = await createStore('renew', ownerId);
  await subscriptions.changeStorePlan({ storeId, planCode: 'growth', reason: 'test_renew' });

  await forcePeriodEnd(storeId, new Date(Date.now() - 60_000).toISOString());
  const before = await subscriptions.getStoreBillingView(storeId);
  const first = await subscriptions.renewStoreSubscription(storeId);
  assert.equal(first.renewed, true);
  const after = await subscriptions.getStoreBillingView(storeId);
  assert.ok(after.subscription.currentPeriodEnd);
  assert.ok(
    new Date(after.subscription.currentPeriodEnd!).getTime() >
      new Date(before.subscription.currentPeriodEnd!).getTime(),
  );

  const second = await subscriptions.renewStoreSubscription(storeId);
  assert.equal(second.renewed, false);
  const renewals = (await eventTypes(storeId)).filter((type) => type === 'renewal');
  assert.equal(renewals.length, 1);
});

test('downgrade programado se aplica en la renovación y deja over_limit si excede', async () => {
  const ownerId = await createOwner('scheduled');
  const storeId = await createStore('scheduled', ownerId);
  await subscriptions.changeStorePlan({ storeId, planCode: 'growth', reason: 'test_scheduled_growth' });

  // 60 SKU: cabe en Growth, no en Starter.
  for (let index = 1; index <= 60; index += 1) {
    await createProduct(ownerId, storeId, `Scheduled ${index}`);
  }

  const scheduled = await subscriptions.changeStorePlan({
    storeId,
    planCode: 'starter',
    effective: 'period_end',
    reason: 'test_scheduled_downgrade',
  });
  assert.equal(scheduled.plan.code, 'growth');
  assert.equal(scheduled.pendingPlan?.code, 'starter');
  assert.ok((await eventTypes(storeId)).includes('plan_change_scheduled'));

  await forcePeriodEnd(storeId, new Date(Date.now() - 60_000).toISOString());
  await subscriptions.renewStoreSubscription(storeId);
  const applied = await subscriptions.getStoreBillingView(storeId);
  assert.equal(applied.plan.code, 'starter');
  assert.equal(applied.usage.overLimit, true);
  assert.ok((await eventTypes(storeId)).includes('plan_change_applied'));
});

test('past_due conserva el plan y expira a Free después de la gracia', async () => {
  const ownerId = await createOwner('pastdue');
  const storeId = await createStore('pastdue', ownerId);
  await subscriptions.changeStorePlan({ storeId, planCode: 'starter', reason: 'test_pastdue' });

  const failed = await subscriptions.markSubscriptionPaymentFailed({ storeId, reason: 'test_failure' });
  assert.equal(failed.status, 'past_due');
  assert.equal(failed.plan.code, 'starter');
  assert.ok((await eventTypes(storeId)).includes('payment_failed'));

  await forcePeriodEnd(storeId, new Date(Date.now() - 5 * 86_400_000).toISOString());
  const result = await lifecycle.runBillingCycle({ now: new Date() });
  assert.ok(result.expired >= 1);

  const expired = await subscriptions.getStoreBillingView(storeId);
  assert.equal(expired.plan.code, 'free');
  assert.equal(expired.status, 'free');
  assert.ok((await eventTypes(storeId)).includes('expired'));
});

// =============================================================================
//  PROMOCIONES
// =============================================================================

test('+1 mes: canje, historial y bloqueo de duplicado', async () => {
  const ownerId = await createOwner('promo');
  const storeId = await createStore('promo', ownerId);
  await subscriptions.changeStorePlan({ storeId, planCode: 'starter', reason: 'test_promo' });
  const before = await subscriptions.getStoreBillingView(storeId);

  await promotions.createPromotion({
    code: 'PROMO1M',
    name: 'Promo test',
    durationMonths: 1,
    planCode: 'starter',
    active: true,
  });
  const after = await promotions.redeemPromotion({ storeId, code: 'promo1m', source: 'seed' });
  assert.ok(after.subscription.currentPeriodEnd);
  assert.ok(
    new Date(after.subscription.currentPeriodEnd!).getTime() >
      new Date(before.subscription.currentPeriodEnd!).getTime(),
  );
  assert.ok((await eventTypes(storeId)).includes('promotion_redeemed'));

  const redemptions = await sql()`
    SELECT COUNT(*)::int AS count FROM promotion_redemptions WHERE store_id = ${storeId}::uuid
  `;
  assert.equal(Number(redemptions[0]?.count), 1);

  await assert.rejects(
    () => promotions.redeemPromotion({ storeId, code: 'PROMO1M', source: 'seed' }),
    (error: unknown) =>
      error instanceof BillingError && error.code === 'promotion_already_redeemed',
  );
  const stillOne = await sql()`
    SELECT COUNT(*)::int AS count FROM promotion_redemptions WHERE store_id = ${storeId}::uuid
  `;
  assert.equal(Number(stillOne[0]?.count), 1);
});

test('promoción vencida, inactiva, máximo agotado, plan equivocado y Free rechazado', async () => {
  const ownerId = await createOwner('promo-rules');
  const storeId = await createStore('promo-rules', ownerId);
  const freeOwner = await createOwner('promo-free');
  const freeStore = await createStore('promo-free', freeOwner);
  await subscriptions.changeStorePlan({ storeId, planCode: 'starter', reason: 'test_promo_rules' });

  await promotions.createPromotion({
    code: 'EXPIRED1M',
    name: 'Vencida',
    endsAt: new Date(Date.now() - 86_400_000).toISOString(),
    active: true,
  });
  await assert.rejects(
    () => promotions.redeemPromotion({ storeId, code: 'EXPIRED1M' }),
    (error: unknown) => error instanceof BillingError && error.code === 'promotion_expired',
  );

  await promotions.createPromotion({ code: 'OFF1M', name: 'Inactiva', active: false });
  await assert.rejects(
    () => promotions.redeemPromotion({ storeId, code: 'OFF1M' }),
    (error: unknown) => error instanceof BillingError && error.code === 'promotion_inactive',
  );

  await assert.rejects(
    () => promotions.redeemPromotion({ storeId: freeStore, code: 'EXPIRED1M' }),
    (error: unknown) =>
      error instanceof BillingError && error.code === 'promotion_requires_paid_plan',
  );

  await promotions.createPromotion({ code: 'GROWONLY', name: 'Solo Growth', planCode: 'growth' });
  await assert.rejects(
    () => promotions.redeemPromotion({ storeId, code: 'GROWONLY' }),
    (error: unknown) =>
      error instanceof BillingError && error.code === 'promotion_plan_mismatch',
  );

  await promotions.createPromotion({ code: 'ONCE1M', name: 'Un canje', maxRedemptions: 1, planCode: 'starter' });
  await promotions.redeemPromotion({ storeId, code: 'ONCE1M' });
  const otherOwner = await createOwner('promo-max-b');
  const otherStore = await createStore('promo-max-b', otherOwner);
  await subscriptions.changeStorePlan({ storeId: otherStore, planCode: 'starter', reason: 'test_promo_max' });
  await assert.rejects(
    () => promotions.redeemPromotion({ storeId: otherStore, code: 'ONCE1M' }),
    (error: unknown) =>
      error instanceof BillingError && error.code === 'promotion_max_redemptions',
  );
});

test('grant manual de Platform Admin extiende el período y deja evento', async () => {
  const ownerId = await createOwner('grant');
  const storeId = await createStore('grant', ownerId);
  await subscriptions.changeStorePlan({ storeId, planCode: 'starter', reason: 'test_grant' });
  const before = await subscriptions.getStoreBillingView(storeId);

  const after = await promotions.grantFreeMonths({ storeId, months: 1, reason: 'test_admin_grant' });
  assert.ok(after.subscription.currentPeriodEnd);
  assert.ok(
    new Date(after.subscription.currentPeriodEnd!).getTime() >
      new Date(before.subscription.currentPeriodEnd!).getTime(),
  );
  assert.ok((await eventTypes(storeId)).includes('admin_grant'));
});

// =============================================================================
//  SEGURIDAD + ADMIN
// =============================================================================

test('merchant B no accede al billing de A', async () => {
  const ownerA = await createOwner('security-a');
  const ownerB = await createOwner('security-b');
  const storeA = await createStore('security-a', ownerA);
  const storeB = await createStore('security-b', ownerB);

  const own = await subscriptions.getStoreBillingForUser(ownerA, storeA);
  assert.equal(own.storeId, storeA);

  await assert.rejects(
    () => subscriptions.getStoreBillingForUser(ownerB, storeA),
    (error: unknown) => error instanceof TenancyError && error.code === 'store_forbidden',
  );
  await assert.rejects(
    () => promotions.redeemPromotionForUser(ownerB, storeA, 'PROMO1M'),
    (error: unknown) => error instanceof TenancyError && error.code === 'store_forbidden',
  );
  await assert.rejects(
    () => subscriptions.getStoreBillingForUser(ownerA, storeB),
    (error: unknown) => error instanceof TenancyError && error.code === 'store_forbidden',
  );
});

test('Platform Admin lista suscripciones e historial', async () => {
  const ownerId = await createOwner('admin-list');
  const storeId = await createStore('admin-list', ownerId);
  await subscriptions.changeStorePlan({ storeId, planCode: 'starter', reason: 'test_admin_list' });

  const rows = await subscriptions.listAdminSubscriptions();
  const row = rows.find((item) => item.storeId === storeId);
  assert.ok(row);
  assert.equal(row.plan.code, 'starter');
  assert.equal(row.status, 'active');
  assert.equal(row.usage.limit, 50);

  const events = await subscriptions.listAdminEventsForStore(storeId);
  assert.ok(events.some((event) => event.eventType === 'plan_changed'));
});
