/**
 * tests/audit-schema.test.ts — lógica pura de scripts/audit-schema.ts.
 *
 * No abre conexiones: valida las guardas de lectura, la redacción de secretos,
 * la determinación del fingerprint y la detección de migraciones 001–007.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertReadOnlySql,
  canonicalize,
  computeFingerprint,
  describeTarget,
  evaluateExpectedMigrations,
  fingerprintSchema,
  normalizeDefinition,
  parseArgs,
  quoteIdentifier,
  redactSecrets,
  type FingerprintSource,
  type MigrationMarkers,
} from '../scripts/audit-schema';

const ALL_MARKERS: MigrationMarkers = {
  duplicatePaymentGuard: true,
  fulfillmentReadyGuard: true,
  fulfillmentCommitGuard: true,
  fulfillmentPickupGuard: true,
  releaseRereservation: true,
};

const ALL_TABLES = [
  'customers',
  'orders',
  'order_items',
  'inventory',
  'inventory_movements',
  'pickup_codes',
  'pickup_attempts',
  'order_status_transitions',
  'order_status_history',
  'payment_webhook_events',
];

const ALL_FUNCTIONS = [
  'inventory_apply_movement',
  'inventory_reserve_order',
  'enforce_order_status_transition',
  'confirm_order_payment',
  'inventory_rereserve_order',
  'redeem_pickup_code_verified',
  'mark_order_ready_for_pickup',
];

// =============================================================================
//  Guarda de solo lectura
// =============================================================================

test('assertReadOnlySql acepta SELECT y WITH', () => {
  assert.equal(assertReadOnlySql('SELECT 1'), 'SELECT 1');
  assert.equal(
    assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'),
    'WITH x AS (SELECT 1) SELECT * FROM x',
  );
  assert.equal(assertReadOnlySql('  select version()  '), 'select version()');
  assert.equal(assertReadOnlySql('-- comentario\nSELECT 1'), '-- comentario\nSELECT 1');
});

test('assertReadOnlySql rechaza DDL/DML', () => {
  for (const statement of [
    'DELETE FROM orders',
    'UPDATE orders SET status = \'cancelled\'',
    'INSERT INTO orders DEFAULT VALUES',
    'DROP TABLE orders',
    'ALTER TABLE orders ADD COLUMN x int',
    'TRUNCATE orders',
    'CREATE TABLE x (id int)',
    'GRANT SELECT ON orders TO public',
  ]) {
    assert.throws(() => assertReadOnlySql(statement), /non-read-only/, statement);
  }
});

test('assertReadOnlySql rechaza múltiples statements y vacío', () => {
  assert.throws(() => assertReadOnlySql('SELECT 1; DELETE FROM orders'), /multiple statements/);
  assert.throws(() => assertReadOnlySql('SELECT 1; SELECT 2'), /multiple statements/);
  assert.throws(() => assertReadOnlySql('   '), /empty statement/);
});

test('assertReadOnlySql permite un punto y coma final', () => {
  assert.equal(assertReadOnlySql('SELECT 1;'), 'SELECT 1;');
});

// =============================================================================
//  Identificadores y secretos
// =============================================================================

test('quoteIdentifier sólo acepta identificadores simples', () => {
  assert.equal(quoteIdentifier('orders'), '"orders"');
  assert.equal(quoteIdentifier('order_items'), '"order_items"');
  for (const unsafe of ['orders; DROP TABLE orders', 'orders"', 'public.orders', '1orders', '']) {
    assert.throws(() => quoteIdentifier(unsafe), /unsafe identifier/, unsafe);
  }
});

test('describeTarget nunca expone usuario, password ni host', () => {
  const target = describeTarget(
    'postgresql://db_user:placeholder-password@ep-example-123.example.invalid:5432/neondb?sslmode=require',
  );
  assert.equal(target, 'postgresql://<redacted>/neondb');
  assert.ok(!target.includes('placeholder-password'));
  assert.ok(!target.includes('db_user'));
  assert.ok(!target.includes('example.invalid'));
});

test('describeTarget tolera URLs inválidas sin filtrar el valor', () => {
  assert.equal(describeTarget('no-es-una-url'), 'postgresql://<redacted>/(unknown)');
});

test('redactSecrets elimina URLs, tokens y passwords', () => {
  const dirty =
    'fallo en postgresql://user:placeholder@host:5432/db password=abc123 Bearer eyJhbGciOi APP_USR-FAKE re_FAKE1234';
  const clean = redactSecrets(dirty);
  for (const forbidden of ['user:placeholder', 'abc123', 'eyJhbGciOi', 'APP_USR-FAKE', 're_FAKE1234']) {
    assert.ok(!clean.includes(forbidden), `no debe incluir ${forbidden}`);
  }
  assert.ok(clean.includes('postgresql://<redacted>'));
});

// =============================================================================
//  Fingerprint
// =============================================================================

test('canonicalize ordena claves de objeto', () => {
  assert.deepEqual(canonicalize({ b: 1, a: 2 }), { a: 2, b: 1 });
  assert.equal(JSON.stringify(canonicalize({ b: 1, a: 2 })), '{"a":2,"b":1}');
});

test('computeFingerprint es determinista ante orden de claves y arrays', () => {
  const first = {
    database: 'neondb',
    tables: [{ name: 'orders' }, { name: 'inventory' }],
    functions: ['b', 'a'],
  };
  const second = {
    functions: ['a', 'b'],
    tables: [{ name: 'inventory' }, { name: 'orders' }],
    database: 'neondb',
  };

  assert.equal(computeFingerprint(first), computeFingerprint(second));
  assert.match(computeFingerprint(first), /^sha256:[a-f0-9]{64}$/);
});

test('computeFingerprint cambia si cambia el esquema', () => {
  const base = { tables: [{ name: 'orders' }], functions: ['confirm_order_payment'] };
  const changed = { tables: [{ name: 'orders' }], functions: ['confirm_order_payment', 'extra'] };
  assert.notEqual(computeFingerprint(base), computeFingerprint(changed));
});

test('fingerprintSchema ignora versión del servidor y nombre de la base', () => {
  const schema: FingerprintSource = {
    tables: [{ name: 'orders', type: 'BASE TABLE' }],
    columns: [],
    constraints: [],
    indexes: [],
    functions: [],
    triggers: [],
    expected: [],
  };

  const neon = { ...schema, serverVersion: 'PostgreSQL 17.11 on aarch64', database: 'neondb' };
  const railway = { ...schema, serverVersion: 'PostgreSQL 17.6 on x86_64', database: 'railway' };

  assert.equal(fingerprintSchema(neon), fingerprintSchema(railway));
  assert.equal(fingerprintSchema(neon), computeFingerprint(schema));
});

test('normalizeDefinition estabiliza CRLF y espacios', () => {
  assert.equal(normalizeDefinition('CREATE  TABLE\r\n  x   (id int)'), 'CREATE TABLE\nx (id int)');
});

// =============================================================================
//  Migraciones esperadas
// =============================================================================

test('evaluateExpectedMigrations marca 001–007 presentes cuando están todos los objetos', () => {
  const result = evaluateExpectedMigrations({
    tables: ALL_TABLES,
    functions: ALL_FUNCTIONS,
    hasExpiredToConfirmed: true,
    markers: ALL_MARKERS,
  });

  assert.equal(result.length, 7);
  for (const check of result) {
    assert.equal(check.present, true, `${check.id}: ${check.detail}`);
    assert.equal(check.detail, 'OK');
  }
});

test('evaluateExpectedMigrations detecta 004 ausente por tabla', () => {
  const result = evaluateExpectedMigrations({
    tables: ALL_TABLES.filter((table) => table !== 'payment_webhook_events'),
    functions: ALL_FUNCTIONS,
    hasExpiredToConfirmed: true,
    markers: ALL_MARKERS,
  });

  const check = result.find((item) => item.id === '004_payment_webhook_diagnostics');
  assert.ok(check);
  assert.equal(check.present, false);
  assert.match(check.detail, /payment_webhook_events/);
});

test('evaluateExpectedMigrations detecta 006 y 007 ausentes por marcadores', () => {
  const result = evaluateExpectedMigrations({
    tables: ALL_TABLES,
    functions: ALL_FUNCTIONS,
    hasExpiredToConfirmed: true,
    markers: {
      ...ALL_MARKERS,
      fulfillmentCommitGuard: false,
      releaseRereservation: false,
    },
  });

  const check006 = result.find((item) => item.id === '006_fulfillment_stock_conflict_guard');
  const check007 = result.find((item) => item.id === '007_release_respects_rereservation');
  assert.equal(check006?.present, false);
  assert.match(check006?.detail ?? '', /inventory_commit_order/);
  assert.equal(check007?.present, false);
  assert.match(check007?.detail ?? '', /prior_releases/);
});

test('evaluateExpectedMigrations detecta 002 sin la transición expired→confirmed', () => {
  const result = evaluateExpectedMigrations({
    tables: ALL_TABLES,
    functions: ALL_FUNCTIONS,
    hasExpiredToConfirmed: false,
    markers: ALL_MARKERS,
  });

  const check = result.find((item) => item.id === '002_payment_confirmation');
  assert.equal(check?.present, false);
  assert.match(check?.detail ?? '', /expired/);
});

// =============================================================================
//  Argumentos
// =============================================================================

test('parseArgs usa valores por defecto', () => {
  assert.deepEqual(parseArgs([]), { json: false, counts: 'key' });
});

test('parseArgs acepta --json y --counts válidos', () => {
  assert.deepEqual(parseArgs(['--json', '--counts=all']), { json: true, counts: 'all' });
  assert.deepEqual(parseArgs(['--counts=skip']), { json: false, counts: 'skip' });
});

test('parseArgs falla cerrado ante valores desconocidos', () => {
  assert.throws(() => parseArgs(['--counts=todo']), /invalid --counts/);
  assert.throws(() => parseArgs(['--drop-tables']), /unknown argument/);
});
