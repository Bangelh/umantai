/**
 * tests/build-info.test.ts — identidad del build para /api/health.
 *
 * Caso que motivó esto: `railway up` NO actualiza `RAILWAY_GIT_COMMIT_SHA`, así
 * que el health mostraba un commit viejo. El manifiesto sellado en build debe
 * ganarle a la variable de plataforma.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BUILD_MANIFEST,
  resolveBuildIdentity,
  type BuildManifest,
} from '../lib/build-info';

const MANIFEST: BuildManifest = {
  buildId: '20261019120000-abc1234',
  commit: 'abc1234def5678',
  commitSource: 'git',
  builtAt: '2026-10-19T12:00:00.000Z',
};

test('el manifiesto del build gana sobre RAILWAY_GIT_COMMIT_SHA desfasado', () => {
  const identity = resolveBuildIdentity({ RAILWAY_GIT_COMMIT_SHA: 'viejo' }, MANIFEST);
  assert.equal(identity.commit, 'abc1234def5678');
  assert.equal(identity.commitSource, 'git');
  assert.equal(identity.buildId, '20261019120000-abc1234');
  assert.equal(identity.builtAt, '2026-10-19T12:00:00.000Z');
});

test('BUILD_COMMIT explícito puede corregir un build ya desplegado', () => {
  const identity = resolveBuildIdentity(
    { BUILD_COMMIT: '  hotfix99  ', BUILD_ID: 'custom-build' },
    MANIFEST,
  );
  assert.equal(identity.commit, 'hotfix99');
  assert.equal(identity.commitSource, 'BUILD_COMMIT');
  assert.equal(identity.buildId, 'custom-build');
});

test('sin manifiesto, cae a las variables de la plataforma', () => {
  assert.equal(
    resolveBuildIdentity({ VERCEL_GIT_COMMIT_SHA: 'vercel-sha' }, DEFAULT_BUILD_MANIFEST).commit,
    'vercel-sha',
  );
  assert.equal(
    resolveBuildIdentity({ RAILWAY_GIT_COMMIT_SHA: 'railway-sha' }, DEFAULT_BUILD_MANIFEST).commit,
    'railway-sha',
  );
});

test('un build real sin commit NO hereda el SHA desfasado de Railway', () => {
  const identity = resolveBuildIdentity(
    { RAILWAY_GIT_COMMIT_SHA: 'commit-viejo' },
    {
      buildId: '20261019120000-nogit',
      commit: null,
      commitSource: 'none',
      builtAt: '2026-10-19T12:00:00.000Z',
    },
  );

  assert.equal(identity.commit, null);
  assert.equal(identity.commitSource, 'build_manifest_unknown');
  assert.equal(identity.buildId, '20261019120000-nogit');
});

test('sin ningún dato no inventa un commit', () => {
  const identity = resolveBuildIdentity({}, DEFAULT_BUILD_MANIFEST);
  assert.equal(identity.commit, null);
  assert.equal(identity.commitSource, 'none');
  assert.equal(identity.buildId, 'dev');
  assert.equal(identity.builtAt, null);
});

test('las variables vacías o con espacios no cuentan', () => {
  const identity = resolveBuildIdentity(
    { BUILD_COMMIT: '   ', VERCEL_GIT_COMMIT_SHA: ' ' },
    DEFAULT_BUILD_MANIFEST,
  );
  assert.equal(identity.commit, null);
});

test('GIT_COMMIT_SHA ya no cuenta como fuente de commit (variable manual vieja)', () => {
  const identity = resolveBuildIdentity(
    { GIT_COMMIT_SHA: '0e1517e2ce5a5d24906b97a94c1bd28c5dccdc38' },
    DEFAULT_BUILD_MANIFEST,
  );
  assert.equal(identity.commit, null);
  assert.equal(identity.commitSource, 'none');
});

test('el deployment nativo de Railway se reporta aunque no haya commit', () => {
  const identity = resolveBuildIdentity(
    { RAILWAY_DEPLOYMENT_ID: 'dep-9', RAILWAY_SNAPSHOT_ID: 'snap-9' },
    {
      ...DEFAULT_BUILD_MANIFEST,
      buildId: '20261028153508-0e1517e',
      builtAt: '2026-10-28T15:35:08.000Z',
      commit: null,
      commitSource: 'none',
    },
  );
  assert.equal(identity.commit, null);
  assert.equal(identity.deploymentId, 'dep-9');
  assert.equal(identity.snapshotId, 'snap-9');
  assert.equal(identity.buildId, '20261028153508-0e1517e');
});

test('el manifiesto versionado tiene la forma esperada y no filtra secretos', () => {
  const current = resolveBuildIdentity({});
  assert.equal(typeof current.buildId, 'string');
  assert.ok(current.buildId.length > 0);
  const serialized = JSON.stringify(current).toLowerCase();
  for (const forbidden of ['postgres://', 'password', 'secret', 'token']) {
    assert.ok(!serialized.includes(forbidden), `el manifiesto filtró "${forbidden}"`);
  }
});
