/**
 * tests/db-driver.test.ts — lógica pura del cliente SQL portable.
 *
 * No abre conexiones: valida la selección de driver y la construcción de SQL
 * parametrizado. La integración real vive en `tests/db.integration.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSqlText,
  closeDbPools,
  createSqlClient,
  resolveDbDriver,
} from '../lib/db-driver.server';

const template = (...parts: string[]): TemplateStringsArray =>
  Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;

test('buildSqlText numera parámetros en orden', () => {
  const result = buildSqlText(template('SELECT * FROM orders WHERE id = ', ' AND status = ', ''), [
    'abc',
    'paid',
  ]);

  assert.equal(result.text, 'SELECT * FROM orders WHERE id = $1 AND status = $2');
  assert.deepEqual(result.values, ['abc', 'paid']);
});

test('buildSqlText no deduplica valores repetidos', () => {
  const result = buildSqlText(template('SELECT ', ', ', ''), ['x', 'x']);
  assert.equal(result.text, 'SELECT $1, $2');
  assert.deepEqual(result.values, ['x', 'x']);
});

test('buildSqlText rechaza un template inconsistente', () => {
  assert.throws(
    () => buildSqlText(template('SELECT ', ''), ['a', 'b']),
    /template_mismatch/,
  );
});

test('resolveDbDriver detecta Neon por host', () => {
  assert.equal(resolveDbDriver('postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb'), 'neon');
  assert.equal(resolveDbDriver('postgresql://u:p@neon.tech/db'), 'neon');
});

test('resolveDbDriver usa pg para Railway, Supabase y local', () => {
  assert.equal(
    resolveDbDriver('postgresql://postgres:p@postgres.railway.internal:5432/railway'),
    'pg',
  );
  assert.equal(resolveDbDriver('postgresql://u:p@localhost:5432/umantai'), 'pg');
  assert.equal(resolveDbDriver('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/db'), 'pg');
});

test('resolveDbDriver respeta DB_DRIVER explícito y falla cerrado', () => {
  assert.equal(resolveDbDriver('postgresql://u@ep-x.neon.tech/db', 'pg'), 'pg');
  assert.equal(resolveDbDriver('postgresql://u@localhost/db', 'neon'), 'neon');
  assert.throws(() => resolveDbDriver('postgresql://u@localhost/db', 'mysql'), /db_driver_invalid/);
});

test('createSqlClient expone tag y transaction sin conectar', async () => {
  const client = createSqlClient('postgresql://user:placeholder@localhost:5432/umantai', 'pg');
  assert.equal(typeof client, 'function');
  assert.equal(typeof client.transaction, 'function');
  await closeDbPools();
});
