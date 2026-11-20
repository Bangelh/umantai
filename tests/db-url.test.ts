import test from 'node:test';
import assert from 'node:assert/strict';

import { isTransactionPoolerUrl, toRuntimeDatabaseUrl } from '../lib/db-url';

const SESSION =
  'postgresql://postgres.abcdef:p%40ss@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?pgbouncer=true&sslmode=require';

test('mueve el pooler de sesión al modo transacción', () => {
  const url = toRuntimeDatabaseUrl(SESSION);
  assert.match(url, /pooler\.supabase\.com:6543/);
  assert.doesNotMatch(url, /:5432/);
  // La contraseña codificada y los parámetros se conservan tal cual.
  assert.match(url, /p%40ss/);
  assert.match(url, /pgbouncer=true&sslmode=require/);
});

test('no toca una URL que ya está en modo transacción', () => {
  const url = SESSION.replace(':5432', ':6543');
  assert.equal(toRuntimeDatabaseUrl(url), url);
});

test('no toca la conexión directa ni un Postgres propio', () => {
  const direct = 'postgresql://postgres:secret@db.abcdef.supabase.co:5432/postgres?sslmode=require';
  assert.equal(toRuntimeDatabaseUrl(direct), direct);
  const railway = 'postgresql://postgres:secret@postgres.railway.internal:5432/railway';
  assert.equal(toRuntimeDatabaseUrl(railway), railway);
});

test('una URL inválida se devuelve sin cambios', () => {
  assert.equal(toRuntimeDatabaseUrl('no-es-una-url'), 'no-es-una-url');
});

test('isTransactionPoolerUrl distingue los tres casos', () => {
  assert.equal(isTransactionPoolerUrl(SESSION), false);
  assert.equal(isTransactionPoolerUrl(SESSION.replace(':5432', ':6543')), true);
  assert.equal(isTransactionPoolerUrl('postgresql://u:p@db.abcdef.supabase.co:5432/postgres'), false);
});
