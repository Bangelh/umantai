#!/usr/bin/env node
/**
 * scripts/write-build-info.mjs — sella el build que se está compilando.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  `/api/health` reportaba `RAILWAY_GIT_COMMIT_SHA`, pero ese valor SOLO lo
 *  actualiza el deploy disparado por GitHub. Con `railway up` (subida directa
 *  del directorio) Railway no reescribe la variable y el health queda mostrando
 *  un commit viejo aunque el código desplegado sea el nuevo.
 *
 *  La solución no depende de la plataforma: se resuelve el commit en TIEMPO DE
 *  BUILD (cuando el repo y el commit correctos están a mano) y se escribe un
 *  manifiesto JSON que se importa en el bundle. En runtime se lee ese valor
 *  embebido, así que el health siempre identifica el build que está corriendo,
 *  sin llamadas externas y sin secretos.
 *
 *  Orden de resolución del commit:
 *    1. BUILD_COMMIT            (explícito; permite fijarlo a mano en CI)
 *    2. RAILWAY_GIT_COMMIT_SHA  (automático cuando el servicio está conectado a GitHub)
 *    3. VERCEL_GIT_COMMIT_SHA
 *    4. `.deploy-commit.json`   (lo escribe `npm run deploy:staging` con el HEAD local)
 *    5. `git rev-parse HEAD`    (build local con repo)
 *
 *  `GIT_COMMIT_SHA` / `GIT_COMMIT` YA NO SE LEEN. Eran variables manuales que
 *  quedaban viejas: `railway up` no las actualiza y el build las prefería sobre
 *  el código real. Un SHA viejo es peor que ninguno.
 *
 *  Si nada está disponible, `commit: null`; el artefacto queda identificado por
 *  `buildId` (timestamp) y `deploymentId` (nativo de Railway). Nunca se inventa.
 *
 *  Uso: `node scripts/write-build-info.mjs` (lo lanza `npm run build` vía
 *  `prebuild`). Escribe `lib/build-info.generated.json`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_FILE = path.join(ROOT, 'lib', 'build-info.generated.json');

const COMMIT_SOURCES = ['BUILD_COMMIT', 'RAILWAY_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA'];
const DEPLOY_STAMP_FILE = path.join(ROOT, '.deploy-commit.json');

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function commitFromEnv() {
  for (const name of COMMIT_SOURCES) {
    const value = readEnv(name);
    if (value) return { commit: value, commitSource: name };
  }
  return null;
}

/**
 * Sello del deploy: lo escribe `scripts/deploy-staging.mjs` con el HEAD local
 * justo antes de `railway up`. Es la única forma de conocer el commit cuando la
 * imagen se sube por CLI (sin GitHub y sin `.git` en el contenedor).
 */
function commitFromDeployStamp() {
  try {
    const raw = readFileSync(DEPLOY_STAMP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const commit = typeof parsed.commit === 'string' ? parsed.commit.trim() : '';
    return commit ? { commit, commitSource: 'deploy_stamp' } : null;
  } catch {
    return null;
  }
}

function commitFromGit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return sha ? { commit: sha, commitSource: 'git' } : null;
  } catch {
    // Sin git (imagen de build sin .git): no es un error, el commit queda null.
    return null;
  }
}

function shortSha(commit) {
  return commit ? commit.slice(0, 7) : 'nogit';
}

const resolved = commitFromEnv() ?? commitFromDeployStamp() ?? commitFromGit();
const builtAt = new Date().toISOString();

/**
 * Id único del build. `BUILD_ID` permite fijarlo desde la plataforma; si no,
 * timestamp + sha corto: cambia en cada build aunque el commit no cambie.
 */
const buildId = readEnv('BUILD_ID') || `${builtAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${shortSha(resolved?.commit)}`;

const manifest = {
  buildId,
  commit: resolved?.commit ?? null,
  commitSource: resolved?.commitSource ?? 'none',
  builtAt,
  // Nativo de Railway: identifica el deployment aunque no haya commit. Es el
  // mismo id que muestra el dashboard, así que sirve para auditar qué corre.
  deploymentId: readEnv('RAILWAY_DEPLOYMENT_ID') || null,
  snapshotId: readEnv('RAILWAY_SNAPSHOT_ID') || null,
};

mkdirSync(path.dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(
  `[build-info] build ${manifest.buildId} · commit ${manifest.commit ?? 'desconocido'} (${manifest.commitSource})` +
    (manifest.deploymentId ? ` · deployment ${manifest.deploymentId}` : ''),
);
