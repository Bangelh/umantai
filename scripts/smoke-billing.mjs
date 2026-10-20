#!/usr/bin/env node
/**
 * scripts/smoke-billing.mjs — smoke REAL de PLANS + SUBSCRIPTIONS en staging.
 *
 * Se ejecuta DENTRO del contenedor `web` (donde viven DATABASE_URL y los
 * secretos), nunca imprime tokens. No usa Mercado Pago de pedidos.
 *
 * Uso:
 *   railway ssh -s web -- sh -lc \
 *     'export PATH=/mise/installs/node/24.21.0/bin:$PATH; \
 *      node scripts/smoke-billing.mjs'
 *
 * Requiere: ADMIN_API_SECRET, CRON_SECRET, DB URL. Crea usuarios/tiendas de
 * smoke con correos únicos; no borra datos existentes.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const base = (process.env.SMOKE_BASE_URL || 'https://web-staging-6756.up.railway.app').replace(/\/+$/, '');
const adminToken = (process.env.ADMIN_API_SECRET || '').trim();
const cronSecret = (process.env.CRON_SECRET || '').trim();
const databaseUrl =
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  '';

if (!adminToken) throw new Error('Falta ADMIN_API_SECRET en el contenedor.');
if (!cronSecret) throw new Error('Falta CRON_SECRET en el contenedor.');
if (!databaseUrl) throw new Error('Falta la URL de PostgreSQL en el contenedor.');

const password = 'Umantai-Smoke-2026!';
const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const results = [];

function record(step, detail = {}) {
  results.push({ step, ok: true, ...detail });
  console.info(`✔ ${step}`);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.admin) headers['x-admin-token'] = adminToken;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body, headers: response.headers };
}

async function signUp(label) {
  const email = `smoke-billing-${label}-${suffix}@example.test`;
  const response = await api('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: base, referer: `${base}/ingresar` },
    body: { email, password, name: `Smoke ${label}` },
  });
  assert.equal(response.status, 200, `sign-up ${label}: ${JSON.stringify(response.body)}`);
  const cookies = response.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, `sign-up ${label} no devolvió cookie`);
  return { id: String(response.body?.user?.id ?? ''), email, cookie };
}

async function createStore(user, label) {
  const slug = `smoke-billing-${label}-${suffix}`.slice(0, 60);
  const response = await api('/api/merchant/stores', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      name: `Smoke Billing ${label} ${suffix.slice(-5)}`,
      slug,
      latitude: -12.0464,
      longitude: -77.0428,
      category: 'abarrotes',
    },
  });
  assert.equal(response.status, 201, `create store ${label}: ${JSON.stringify(response.body)}`);
  return { id: String(response.body.store.id), slug };
}

async function billing(storeId, user) {
  const response = await api(`/api/merchant/stores/${storeId}/billing`, { cookie: user.cookie });
  assert.equal(response.status, 200, `billing ${storeId}: ${JSON.stringify(response.body)}`);
  return response.body.billing;
}

async function createProduct(storeId, user, label, visible = true) {
  const response = await api(`/api/merchant/stores/${storeId}/products`, {
    method: 'POST',
    cookie: user.cookie,
    body: { name: `${label} ${randomUUID().slice(0, 6)}`, priceCents: 1000, visible },
  });
  assert.equal(response.status, 201, `product ${label}: ${JSON.stringify(response.body)}`);
  return response.body.product;
}

async function changePlan(storeId, user, planCode, effective = 'immediate') {
  const response = await api(`/api/merchant/stores/${storeId}/billing/change-plan`, {
    method: 'POST',
    cookie: user.cookie,
    body: { planCode, effective },
  });
  assert.equal(response.status, 200, `change-plan ${planCode}: ${JSON.stringify(response.body)}`);
  return response.body.billing;
}

async function adminChangePlan(storeId, planCode) {
  const response = await api(`/api/admin/billing/subscriptions/${storeId}/change-plan`, {
    method: 'POST',
    admin: true,
    body: { planCode, effective: 'immediate', reason: 'smoke_admin_downgrade' },
  });
  assert.equal(response.status, 200, `admin change-plan: ${JSON.stringify(response.body)}`);
  return response.body.billing;
}

const db = new Client({
  connectionString: databaseUrl,
  ssl: /sslmode=(require|verify)/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
});
await db.connect();

async function forcePeriodEnd(storeId, iso) {
  await db.query(
    `UPDATE store_subscriptions
        SET current_period_start = $1::timestamptz - INTERVAL '1 day',
            current_period_end = $1::timestamptz
      WHERE store_id = $2::uuid`,
    [iso, storeId],
  );
}

async function runCron() {
  const response = await api('/api/cron/billing', {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(response.status, 200, `cron billing: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function adminHistory(storeId) {
  const response = await api(`/api/admin/billing/subscriptions/${storeId}/history`, { admin: true });
  assert.equal(response.status, 200, `admin history: ${JSON.stringify(response.body)}`);
  return response.body;
}

try {
  const merchantA = await signUp('a');
  const storeA = await createStore(merchantA, 'a');

  // 1. Free automática.
  let current = await billing(storeA.id, merchantA);
  assert.equal(current.plan.code, 'free');
  assert.equal(current.status, 'free');
  assert.equal(current.usage.limit, 25);
  record('1. tienda nueva recibe Free 25', { store: storeA.slug });

  // 2. 25 SKU permitidos.
  const products = [];
  for (let index = 1; index <= 25; index += 1) {
    products.push(await createProduct(storeA.id, merchantA, `Free ${index}`));
  }
  current = await billing(storeA.id, merchantA);
  assert.equal(current.usage.current, 25);
  record('2. 25 SKU permitidos');

  // 3. SKU 26 rechazado.
  const blocked26 = await api(`/api/merchant/stores/${storeA.id}/products`, {
    method: 'POST',
    cookie: merchantA.cookie,
    body: { name: `Free 26 ${suffix}`, priceCents: 1000, visible: true },
  });
  assert.equal(blocked26.status, 409);
  assert.equal(blocked26.body.code, 'plan_sku_limit_reached');
  assert.equal(blocked26.body.plan, 'free');
  assert.equal(blocked26.body.limit, 25);
  assert.equal(blocked26.body.current, 25);
  record('3. SKU 26 bloqueado con plan_sku_limit_reached');

  // 4. Upgrade Starter.
  current = await changePlan(storeA.id, merchantA, 'starter');
  assert.equal(current.plan.code, 'starter');
  assert.equal(current.status, 'active');
  record('4. upgrade a Starter');

  // 5. Hasta 50 SKU.
  for (let index = 26; index <= 50; index += 1) {
    products.push(await createProduct(storeA.id, merchantA, `Starter ${index}`));
  }
  current = await billing(storeA.id, merchantA);
  assert.equal(current.usage.current, 50);
  record('5. hasta 50 SKU');

  // 6. Upgrade Growth y SKU 51.
  current = await changePlan(storeA.id, merchantA, 'growth');
  assert.equal(current.plan.code, 'growth');
  products.push(await createProduct(storeA.id, merchantA, 'Growth 51'));
  current = await billing(storeA.id, merchantA);
  assert.equal(current.usage.current, 51);
  record('6. upgrade Growth y SKU 51 permitido');

  // 7. Código +1 mes.
  const promoCode = `SMOKE1M${suffix.replace(/\D/g, '').slice(-8)}`;
  const promo = await api('/api/admin/promotions', {
    method: 'POST',
    admin: true,
    body: { code: promoCode, name: `Smoke +1 mes ${suffix}`, durationMonths: 1, maxRedemptions: 10 },
  });
  assert.equal(promo.status, 201, JSON.stringify(promo.body));
  const beforePromo = current.subscription.currentPeriodEnd;
  const redeemed = await api(`/api/merchant/stores/${storeA.id}/billing/redeem`, {
    method: 'POST',
    cookie: merchantA.cookie,
    body: { code: promoCode },
  });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.ok(new Date(redeemed.body.billing.subscription.currentPeriodEnd).getTime() > new Date(beforePromo).getTime());
  record('7. código +1 mes aplicado', { code: promoCode });

  // 8. Segundo canje bloqueado.
  const duplicate = await api(`/api/merchant/stores/${storeA.id}/billing/redeem`, {
    method: 'POST',
    cookie: merchantA.cookie,
    body: { code: promoCode },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'promotion_already_redeemed');
  record('8. segundo canje bloqueado');

  // 9. Downgrade inmediato (admin) a Starter.
  current = await adminChangePlan(storeA.id, 'starter');
  assert.equal(current.plan.code, 'starter');
  record('9. downgrade a Starter');

  // 10. over_limit: 51 > 50.
  assert.equal(current.usage.overLimit, true);
  assert.ok(current.subscription.overLimitAt);
  const blockedOver = await api(`/api/merchant/stores/${storeA.id}/products`, {
    method: 'POST',
    cookie: merchantA.cookie,
    body: { name: `Bloqueado ${suffix}`, priceCents: 1000, visible: true },
  });
  assert.equal(blockedOver.status, 409);
  assert.equal(blockedOver.body.code, 'plan_sku_limit_reached');
  record('10. over_limit bloquea publicaciones y conserva productos');

  // 11. Despublicar reduce uso y limpia over_limit.
  for (const product of products.slice(0, 2)) {
    const hide = await api(`/api/merchant/stores/${storeA.id}/products/${product.id}`, {
      method: 'PATCH',
      cookie: merchantA.cookie,
      body: { visible: false },
    });
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
  }
  current = await billing(storeA.id, merchantA);
  assert.equal(current.usage.current, 49);
  assert.equal(current.usage.overLimit, false);
  products.push(await createProduct(storeA.id, merchantA, 'Reemplazo'));
  current = await billing(storeA.id, merchantA);
  assert.equal(current.usage.current, 50);
  record('11. despublicar SKU reduce uso y permite volver al límite');

  // 12. cancel_at_period_end conserva el plan.
  const cancelled = await api(`/api/merchant/stores/${storeA.id}/billing/cancel`, {
    method: 'POST',
    cookie: merchantA.cookie,
    body: { reason: 'smoke_cancel' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.billing.status, 'cancelled');
  assert.equal(cancelled.body.billing.plan.code, 'starter');
  assert.equal(cancelled.body.billing.subscription.cancelAtPeriodEnd, true);
  record('12. cancel_at_period_end activo');

  // 13. Renovación real de otra tienda, vía cron idempotente.
  const merchantRenew = await signUp('renew');
  const storeRenew = await createStore(merchantRenew, 'renew');
  await changePlan(storeRenew.id, merchantRenew, 'starter');
  await forcePeriodEnd(storeRenew.id, new Date(Date.now() - 60_000).toISOString());
  const beforeRenew = await billing(storeRenew.id, merchantRenew);
  const cron1 = await runCron();
  const afterRenew = await billing(storeRenew.id, merchantRenew);
  assert.equal(afterRenew.status, 'active');
  assert.ok(new Date(afterRenew.subscription.currentPeriodEnd).getTime() > new Date(beforeRenew.subscription.currentPeriodEnd).getTime());
  const endAfterFirst = afterRenew.subscription.currentPeriodEnd;
  await runCron();
  const afterSecond = await billing(storeRenew.id, merchantRenew);
  assert.equal(afterSecond.subscription.currentPeriodEnd, endAfterFirst);
  record('13. renovación por cron idempotente', { cronRenewed: cron1.renewed });

  // Cancelación vencida -> Free.
  await forcePeriodEnd(storeA.id, new Date(Date.now() - 60_000).toISOString());
  await runCron();
  const afterCancel = await billing(storeA.id, merchantA);
  assert.equal(afterCancel.plan.code, 'free');
  assert.equal(afterCancel.status, 'free');
  record('13b. cancelación vencida pasa a Free');

  // 14. Fallo de pago simulado -> past_due.
  const failure = await api(`/api/admin/billing/subscriptions/${storeRenew.id}/simulate-payment-failure`, {
    method: 'POST',
    admin: true,
    body: { reason: 'smoke_payment_failure' },
  });
  assert.equal(failure.status, 200, JSON.stringify(failure.body));
  assert.equal(failure.body.billing.status, 'past_due');
  assert.equal(failure.body.billing.plan.code, 'starter');
  record('14. fallo de pago simulado deja past_due sin desactivar tienda');

  // 15. Merchant B no ve billing de A.
  const merchantB = await signUp('b');
  const forbidden = await api(`/api/merchant/stores/${storeA.id}/billing`, { cookie: merchantB.cookie });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'store_forbidden');
  record('15. merchant B no accede al billing de A');

  // 16. Platform Admin ve historial.
  const history = await adminHistory(storeRenew.id);
  const eventTypes = history.events.map((event) => event.eventType);
  for (const expected of ['subscription_created', 'plan_changed', 'renewal', 'payment_failed']) {
    assert.ok(eventTypes.includes(expected), `historial sin ${expected}: ${eventTypes.join(',')}`);
  }
  record('16. Platform Admin ve historial completo', { eventTypes });

  console.info(JSON.stringify({ ok: true, base, stores: { smoke: storeA.slug, renewal: storeRenew.slug }, steps: results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, completed: results, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await db.end().catch(() => undefined);
}
