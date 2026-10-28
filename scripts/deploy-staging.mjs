#!/usr/bin/env node
/**
 * scripts/deploy-staging.mjs — despliegue a staging con el commit REAL sellado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROBLEMA QUE RESUELVE
 *
 *  `railway up` sube el directorio de trabajo, no un commit: el contenedor no
 *  tiene `.git` y Railway no recibe `RAILWAY_GIT_COMMIT_SHA` (solo lo hace si el
 *  servicio está conectado a GitHub). Por eso `/api/health` terminaba leyendo
 *  `GIT_COMMIT_SHA`, una variable manual que nadie actualizaba.
 *
 *  SOLUCIÓN MÍNIMA
 *
 *  1. Antes de subir, se escribe `.deploy-commit.json` con el HEAD local.
 *     Ese archivo SÍ viaja en el upload (no está en `.gitignore`), así que
 *     `scripts/write-build-info.mjs` lo lee durante el build y lo sella en el
 *     bundle como `commitSource: "deploy_stamp"`.
 *  2. Al terminar, se borra el archivo: el árbol queda limpio.
 *  3. Si algún día se conecta GitHub, `RAILWAY_GIT_COMMIT_SHA` gana solo y este
 *     sello deja de ser necesario (sigue siendo inocuo).
 *
 *  USO
 *
 *    node scripts/deploy-staging.mjs                 # deploy + verificación
 *    node scripts/deploy-staging.mjs --verify-only   # solo comprobar el health
 *    node scripts/deploy-staging.mjs --no-verify     # deploy sin esperar health
 *
 *  Nunca toca Producción: el servicio/entorno están fijados a `web`/`staging`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STAMP_FILE = path.join(ROOT, '.deploy-commit.json');
const SERVICE = 'web';
const ENVIRONMENT = 'staging';
const BASE_URL = (process.env.STAGING_URL || 'https://umantai.com').replace(/\/$/, '');
const VERIFY_TIMEOUT_MS = Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS || 12 * 60_000);
const POLL_MS = 10_000;

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify-only');
const skipVerify = args.has('--no-verify');

function git(...argv) {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Mantiene el sello fuera de `git status` sin tocar `.gitignore` (que Railway respeta). */
function ignoreLocally(relativePath) {
  const excludeFile = path.join(ROOT, '.git', 'info', 'exclude');
  if (!existsSync(excludeFile)) return;
  const current = readFileSync(excludeFile, 'utf8');
  if (current.split(/\r?\n/).includes(relativePath)) return;
  writeFileSync(excludeFile, `${current.trimEnd()}\n${relativePath}\n`, 'utf8');
}

async function readHealth() {
  const response = await fetch(`${BASE_URL}/api/health`, { headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
}

async function verify(expected) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const report = await readHealth();
      last = report;
      const builtAt = report?.build?.builtAt ? Date.parse(report.build.builtAt) : 0;
      const fresh = builtAt >= Date.parse(expected.stampedAt) - 60_000;
      if (fresh) {
        const ok = report.commit === expected.commit;
        console.log(
          `[deploy] health: commit=${report.commit ?? 'null'} source=${report.build?.commitSource}` +
            ` build=${report.build?.buildId} deployment=${report.build?.deploymentId ?? '—'}`,
        );
        if (!ok) {
          console.error(
            `[deploy] ✘ el health no coincide con el HEAD (${expected.commit}). Revisar el sello del build.`,
          );
          return false;
        }
        console.log(`[deploy] ✔ el artefacto en ${BASE_URL} reporta el commit ${expected.commit}`);
        return true;
      }
    } catch (error) {
      console.log(`[deploy] esperando health… (${error instanceof Error ? error.message : 'sin respuesta'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.error('[deploy] ✘ no se confirmó el build nuevo en el plazo:', JSON.stringify(last?.build ?? null));
  return false;
}

async function main() {
  if (verifyOnly) {
    const report = await readHealth();
    console.log(JSON.stringify({ commit: report.commit, build: report.build, environment: report.environment }, null, 2));
    return 0;
  }

  const commit = git('rev-parse', 'HEAD');
  // Solo cambios en archivos versionados: los artefactos locales sin trackear
  // (notas, volcados) no afectan a lo que se despliega y no deben advertir.
  const dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;

  const stamp = { commit, dirty, stampedAt: new Date().toISOString() };
  writeFileSync(STAMP_FILE, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  await ignoreLocally(path.basename(STAMP_FILE));

  console.log(
    `[deploy] staging ← ${commit.slice(0, 7)}${dirty ? ' (árbol con cambios sin commitear)' : ''}`,
  );

  let status = 1;
  try {
    const result = spawnSync('railway', ['up', '--service', SERVICE, '--environment', ENVIRONMENT], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    status = result.status ?? 1;
  } finally {
    rmSync(STAMP_FILE, { force: true });
  }

  if (status !== 0) {
    console.error('[deploy] ✘ railway up falló');
    return status;
  }

  if (skipVerify) return 0;
  return (await verify(stamp)) ? 0 : 1;
}

process.exitCode = await main();
