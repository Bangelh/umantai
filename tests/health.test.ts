/**
 * tests/health.test.ts — /api/health sin base real.
 *
 * El chequeo de Postgres se inyecta, así que estos tests verifican el CONTRATO
 * del reporte: campos exactos, resolución de entorno (APP_ENV manda), status
 * 200/503 y ausencia de cualquier dato sensible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHealthReport,
  healthResponse,
  resolveBuildCommit,
  type HealthDatabase,
} from '../lib/health.server';

function fixedDeps(database: HealthDatabase) {
  return {
    checkDatabase: async () => database,
    env: { APP_ENV: 'staging' },
    commit: 'abc1234',
    now: () => new Date('2026-10-19T12:00:00.000Z'),
  };
}

test('reporte sano: ok, versión, commit, entorno, driver y timestamp', async () => {
  const report = await buildHealthReport(fixedDeps({ reachable: true, type: 'pg' }));

  assert.deepEqual(report, {
    ok: true,
    version: '0.1.0',
    commit: 'abc1234',
    environment: 'staging',
    database: { reachable: true, type: 'pg' },
    timestamp: '2026-10-19T12:00:00.000Z',
  });
});

test('reporte NO contiene URL, usuario, password ni host', async () => {
  const report = await buildHealthReport(fixedDeps({ reachable: true, type: 'neon' }));
  const serialized = JSON.stringify(report).toLowerCase();

  for (const forbidden of ['postgres://', 'postgresql://', 'password', 'username', 'host', 'neon.tech']) {
    assert.ok(!serialized.includes(forbidden), `el reporte filtró "${forbidden}"`);
  }
  assert.deepEqual(Object.keys(report).sort(), [
    'commit',
    'database',
    'environment',
    'ok',
    'timestamp',
    'version',
  ]);
});

test('sin base configurada: no sano y driver none', async () => {
  const report = await buildHealthReport({
    ...fixedDeps({ reachable: false, type: 'none' }),
    env: {},
    commit: null,
  });

  assert.equal(report.ok, false);
  assert.equal(report.environment, 'development');
  assert.equal(report.commit, null);
  assert.deepEqual(report.database, { reachable: false, type: 'none' });
});

test('APP_ENV=production gana sobre VERCEL_ENV=preview', async () => {
  const report = await buildHealthReport({
    ...fixedDeps({ reachable: true, type: 'pg' }),
    env: { APP_ENV: 'production', VERCEL_ENV: 'preview' },
  });
  assert.equal(report.environment, 'production');
});

test('HTTP: 200 cuando la base responde y 503 cuando no', async () => {
  const healthy = await healthResponse(fixedDeps({ reachable: true, type: 'pg' }));
  assert.equal(healthy.status, 200);
  assert.equal(healthy.headers.get('cache-control'), 'no-store');

  const down = await healthResponse(fixedDeps({ reachable: false, type: 'pg' }));
  assert.equal(down.status, 503);
  assert.equal((await down.json()).ok, false);
});

test('commit: Railway y Vercel exponen variables distintas', () => {
  assert.equal(resolveBuildCommit({ RAILWAY_GIT_COMMIT_SHA: 'railway-sha' }), 'railway-sha');
  assert.equal(resolveBuildCommit({ VERCEL_GIT_COMMIT_SHA: 'vercel-sha' }), 'vercel-sha');
  assert.equal(resolveBuildCommit({ GIT_COMMIT_SHA: '  ' }), null);
  assert.equal(resolveBuildCommit({}), null);
});
