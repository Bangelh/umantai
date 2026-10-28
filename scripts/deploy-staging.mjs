#!/usr/bin/env node
/**
 * scripts/deploy-staging.mjs — despliegue a staging con verificación del artefacto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROBLEMA QUE RESUELVE
 *
 *  `railway up` sube el directorio de trabajo, no un commit: el contenedor no
 *  tiene `.git`, Railway no define `RAILWAY_GIT_COMMIT_SHA` (solo con GitHub) y
 *  `RAILWAY_DEPLOYMENT_ID` no existe en tiempo de BUILD. Por eso el health
 *  terminaba leyendo `GIT_COMMIT_SHA`, una variable manual que nadie actualizaba.
 *
 *  QUÉ HACE
 *
 *  1. Lee el health actual (deployment anterior).
 *  2. Corre `railway up` y espera a que termine.
 *  3. Consulta `/api/health` hasta que reporte OTRO `deploymentId` con `builtAt`
 *     posterior al inicio del deploy. Ese id es el nativo de Railway: el mismo
 *     que muestra el dashboard, único por artefacto y automático.
 *  4. Si además hay commit (BUILD_COMMIT, CI o GitHub conectado), lo informa.
 *
 *  Un sello de commit en archivo NO funciona: Railway no sube archivos sin
 *  trackear (verificado en staging). El script no intenta ese camino.
 *
 *  USO
 *
 *    npm run deploy:staging            # deploy + verificación
 *    npm run health:staging            # solo comprobar el health
 *    node scripts/deploy-staging.mjs --no-verify
 *
 *  Nunca toca Producción: servicio/entorno fijados a `web`/`staging`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync, spawnSync } from 'node:child_process';

const SERVICE = 'web';
const ENVIRONMENT = 'staging';
const BASE_URL = (process.env.STAGING_URL || 'https://umantai.com').replace(/\/$/, '');
const VERIFY_TIMEOUT_MS = Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS || 20 * 60_000);
const POLL_MS = 10_000;

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify-only');
const skipVerify = args.has('--no-verify');

function git(...argv) {
  try {
    return execFileSync('git', argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function readHealth() {
  const response = await fetch(`${BASE_URL}/api/health`, {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
}

function describe(report) {
  const build = report?.build ?? {};
  return (
    `commit=${report?.commit ?? 'null'} (${build.commitSource ?? '—'}) ` +
    `build=${build.buildId ?? '—'} deployment=${build.deploymentId ?? '—'}`
  );
}

async function verify(previousDeploymentId, startedAt) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let last = null;

  while (Date.now() < deadline) {
    try {
      const report = await readHealth();
      last = report;
      const deploymentId = report?.build?.deploymentId ?? null;
      const builtAt = report?.build?.builtAt ? Date.parse(report.build.builtAt) : 0;
      const isNew = deploymentId !== null && deploymentId !== previousDeploymentId;
      const isFresh = builtAt >= startedAt - 60_000;

      if (isNew && isFresh) {
        console.log(`[deploy] health: ${describe(report)}`);
        console.log(`[deploy] ✔ ${BASE_URL} corre el deployment ${deploymentId}`);
        if (!report?.commit) {
          console.log(
            '[deploy] (sin commit: Railway no lo expone sin integración con GitHub; el deploymentId identifica el artefacto)',
          );
        }
        return true;
      }
    } catch (error) {
      console.log(
        `[deploy] esperando health… (${error instanceof Error ? error.message : 'sin respuesta'})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.error('[deploy] ✘ no se confirmó un deployment nuevo en el plazo:', describe(last));
  return false;
}

async function main() {
  if (verifyOnly) {
    const report = await readHealth();
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          environment: report.environment,
          commit: report.commit,
          build: report.build,
          database: report.database,
        },
        null,
        2,
      ),
    );
    return report.ok ? 0 : 1;
  }

  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;
  const startedAt = Date.now();

  let previousDeploymentId = null;
  try {
    previousDeploymentId = (await readHealth())?.build?.deploymentId ?? null;
  } catch {
    // Si el health no responde, igual se despliega: la verificación lo detectará.
  }

  console.log(
    `[deploy] staging ← ${commit ? commit.slice(0, 7) : 'sin git'}${
      dirty ? ' (con cambios sin commitear)' : ''
    } · anterior ${previousDeploymentId ?? '—'}`,
  );

  const result = spawnSync('railway', ['up', '--service', SERVICE, '--environment', ENVIRONMENT], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if ((result.status ?? 1) !== 0) {
    console.error('[deploy] ✘ railway up falló');
    return result.status ?? 1;
  }

  if (skipVerify) return 0;
  return (await verify(previousDeploymentId, startedAt)) ? 0 : 1;
}

process.exitCode = await main();
