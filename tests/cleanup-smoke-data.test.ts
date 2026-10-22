/**
 * tests/cleanup-smoke-data.test.ts — puertas de seguridad del borrado demo.
 *
 * El script solo puede correr en staging/test y es dry-run por defecto. Estos
 * tests comprueban los gates SIN base de datos:
 *   · Producción se rechaza antes de intentar conectar.
 *   · APP_ENV vacío o desconocido se rechaza.
 *   · Sin URL de PostgreSQL aborta en vez de "no hacer nada" en silencio.
 *
 * El borrado real (con `--confirm`) se valida en staging, contra datos smoke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts/cleanup-smoke-data.ts');

const DB_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'BANGELH_DATABASE_URL',
  'BANGELH_POSTGRES_URL',
  'BANGELH_POSTGRES_URL_NON_POOLING',
  'UMANTAI_DATABASE_URL',
  'UMANTAI_POSTGRES_URL',
  'UMANTAI_POSTGRES_URL_NON_POOLING',
  'UMANTAI_URL_DATABASE_URL',
  'UMANTAI_URL_POSTGRES_URL',
  'UMANTAI_URL_POSTGRES_URL_NON_POOLING',
];

function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of DB_KEYS) {
    if (!(key in overrides)) delete env[key];
  }
  return env;
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env,
  });
}

test('rechaza Producción incluso con URL de base configurada', () => {
  const result = run(
    cleanEnv({
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@example.test:5432/db',
      // `lib/env.ts` valida el entorno de Producción al importar. Se completa con
      // valores ficticios para llegar a la puerta propia del script.
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SOLO corre con APP_ENV=staging o test/);
  assert.match(result.stderr, /Producción está explícitamente bloqueada/);
});

test('rechaza APP_ENV vacío', () => {
  const result = run(cleanEnv({ APP_ENV: '' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APP_ENV="\(vacío\)"/);
});

test('rechaza APP_ENV desconocido', () => {
  const result = run(cleanEnv({ APP_ENV: 'preview' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APP_ENV="preview"/);
});

test('en staging sin URL aborta en vez de simular un dry-run', () => {
  const result = run(cleanEnv({ APP_ENV: 'staging' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Falta la URL de PostgreSQL/);
});
