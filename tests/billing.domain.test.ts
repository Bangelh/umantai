import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_DEFINITIONS,
  PlanLimitError,
  addMonthsUtc,
  formatSkuUsage,
  formatUsdCents,
  hasPaidAccess,
  skuUsage,
} from '../lib/billing';

test('catálogo aprobado: Free 25, Starter 50, Growth 100 y precios USD', () => {
  const byCode = Object.fromEntries(PLAN_DEFINITIONS.map((plan) => [plan.code, plan]));
  assert.equal(byCode.free.skuLimit, 25);
  assert.equal(byCode.starter.skuLimit, 50);
  assert.equal(byCode.growth.skuLimit, 100);
  assert.equal(byCode.free.priceCents, 0);
  assert.equal(byCode.starter.priceCents, 400);
  assert.equal(byCode.growth.priceCents, 600);
  assert.equal(byCode.growth.currency, 'USD');
});

test('skuUsage permite el límite exacto y marca over_limit en límite + 1', () => {
  const exact = skuUsage(25, 25);
  assert.equal(exact.current, 25);
  assert.equal(exact.remaining, 0);
  assert.equal(exact.percent, 100);
  assert.equal(exact.overLimit, false);

  const over = skuUsage(26, 25);
  assert.equal(over.overLimit, true);
  assert.equal(over.remaining, 0);
});

test('error estructurado plan_sku_limit_reached', () => {
  const error = new PlanLimitError({ plan: 'free', limit: 25, current: 25, requested: 1 });
  assert.equal(error.code, 'plan_sku_limit_reached');
  assert.equal(error.status, 409);
  assert.equal(error.plan, 'free');
  assert.equal(error.limit, 25);
  assert.equal(error.current, 25);
  assert.equal(error.requested, 1);
});

test('aritmética de meses conserva el día y recorta fin de mes', () => {
  assert.equal(addMonthsUtc('2026-01-31T12:00:00.000Z', 1).toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(addMonthsUtc('2026-01-15T00:00:00.000Z', 2).toISOString(), '2026-03-15T00:00:00.000Z');
  assert.equal(addMonthsUtc('2026-12-31T00:00:00.000Z', 1).toISOString(), '2027-01-31T00:00:00.000Z');
});

test('cancelación programada conserva acceso hasta el final del período', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  assert.equal(hasPaidAccess('active', '2026-11-19T12:00:00.000Z', now), true);
  assert.equal(hasPaidAccess('cancelled', '2026-11-19T12:00:00.000Z', now), true);
  assert.equal(hasPaidAccess('cancelled', '2026-10-01T12:00:00.000Z', now), false);
  assert.equal(hasPaidAccess('free', null, now), false);
});

test('formato comercial', () => {
  assert.equal(formatUsdCents(400), 'US$4.00');
  assert.equal(formatUsdCents(0), 'US$0.00');
  assert.equal(formatSkuUsage(18, 25), '18 / 25 SKU utilizados');
});
