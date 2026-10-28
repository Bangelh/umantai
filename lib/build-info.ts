/**
 * lib/build-info.ts — identidad del build desplegado (sin secretos).
 *
 * El manifiesto (`build-info.generated.json`) lo escribe `scripts/write-build-info.mjs`
 * en tiempo de build y queda EMBEBIDO en el bundle. Por eso `/api/health` puede
 * identificar el build que realmente corre aunque `RAILWAY_GIT_COMMIT_SHA` esté
 * desfasado (p. ej. cuando se despliega con `railway up`).
 *
 * Precedencia:
 *   1. `BUILD_COMMIT`  → override explícito de runtime (útil para corregir un build).
 *   2. manifiesto      → lo resuelto al compilar (git / Vercel / Railway / sello).
 *   3. variables de plataforma en runtime → solo si el manifiesto es de desarrollo.
 *
 * Nunca se inventa un SHA: si no hay dato, `commit` es `null`.
 *
 * IDENTIDAD DEL ARTEFACTO
 *
 *   Un commit no siempre existe (imagen subida por `railway up`, sin GitHub y
 *   sin `.git` en el contenedor). En ese caso el build sigue siendo
 *   identificable de forma única por:
 *
 *     buildId       timestamp del build, sellado al compilar
 *     deploymentId  `RAILWAY_DEPLOYMENT_ID`, nativo de la plataforma
 *
 *   Por eso `GIT_COMMIT_SHA` / `GIT_COMMIT` ya no cuentan: son variables
 *   manuales que quedan viejas y hacían que el health mintiera.
 */

import manifestJson from './build-info.generated.json';

export interface BuildManifest {
  buildId: string;
  commit: string | null;
  commitSource: string;
  builtAt: string | null;
  /** Id del deployment de Railway (mismo que el dashboard). */
  deploymentId?: string | null;
  /** Snapshot de build de Railway. */
  snapshotId?: string | null;
}

export type RuntimeEnvSource = Record<string, string | undefined>;

export interface BuildIdentity {
  /** Id único del build (timestamp + sha por defecto). */
  buildId: string;
  /** SHA del commit, si se pudo resolver. */
  commit: string | null;
  /** De dónde salió el commit: `BUILD_COMMIT`, `git`, `VERCEL_GIT_COMMIT_SHA`… */
  commitSource: string;
  /** ISO 8601 del build, o `null` si el manifiesto es el de desarrollo. */
  builtAt: string | null;
  /** Deployment nativo de Railway; `null` fuera de Railway o sin dato. */
  deploymentId: string | null;
  /** Snapshot de build de Railway; `null` si no aplica. */
  snapshotId: string | null;
}

/** Manifiesto por defecto versionado en el repo (se sobrescribe en cada build). */
export const DEFAULT_BUILD_MANIFEST: BuildManifest = {
  buildId: 'dev',
  commit: null,
  commitSource: 'none',
  builtAt: null,
  deploymentId: null,
  snapshotId: null,
};

/**
 * Variables de plataforma que sí son automáticas. `GIT_COMMIT_SHA`/`GIT_COMMIT`
 * quedaron fuera a propósito: se mantenían a mano y quedaban desfasadas.
 */
const PLATFORM_COMMIT_VARS = ['RAILWAY_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA'] as const;

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Identidad del deployment: el manifiesto manda; Railway es el respaldo. */
function resolveDeployment(
  env: RuntimeEnvSource,
  manifest: BuildManifest,
): { deploymentId: string | null; snapshotId: string | null } {
  return {
    deploymentId:
      (typeof manifest.deploymentId === 'string' && manifest.deploymentId.trim()) ||
      clean(env.RAILWAY_DEPLOYMENT_ID) ||
      null,
    snapshotId:
      (typeof manifest.snapshotId === 'string' && manifest.snapshotId.trim()) ||
      clean(env.RAILWAY_SNAPSHOT_ID) ||
      null,
  };
}

/**
 * Resuelve la identidad del build. Puro: recibe env y manifiesto para poder
 * testear todos los casos sin tocar el proceso ni el sistema de archivos.
 */
export function resolveBuildIdentity(
  env: RuntimeEnvSource = process.env,
  manifest: BuildManifest = manifestJson as BuildManifest,
): BuildIdentity {
  const deployment = resolveDeployment(env, manifest);
  const explicit = clean(env.BUILD_COMMIT);
  if (explicit) {
    return {
      buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
      commit: explicit,
      commitSource: 'BUILD_COMMIT',
      builtAt: manifest.builtAt ?? null,
      ...deployment,
    };
  }

  if (manifest.commit) {
    return {
      buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
      commit: manifest.commit,
      commitSource: manifest.commitSource || 'build_manifest',
      builtAt: manifest.builtAt ?? null,
      ...deployment,
    };
  }

  // Si el manifiesto es de un BUILD REAL (`builtAt` presente) pero no pudo
  // resolver el commit, NO se cae a `RAILWAY_GIT_COMMIT_SHA`: con `railway up`
  // esa variable queda en un commit viejo y reportarla sería mentir otra vez.
  // El build sigue siendo identificable por `build.buildId`.
  if (manifest.builtAt) {
    return {
      buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
      commit: null,
      commitSource: 'build_manifest_unknown',
      builtAt: manifest.builtAt,
      ...deployment,
    };
  }

  for (const name of PLATFORM_COMMIT_VARS) {
    const value = clean(env[name]);
    if (value) {
      return {
        buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
        commit: value,
        commitSource: name,
        builtAt: manifest.builtAt ?? null,
        ...deployment,
      };
    }
  }

  return {
    buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
    commit: null,
    commitSource: 'none',
    builtAt: manifest.builtAt ?? null,
    ...deployment,
  };
}

/** Identidad del build embebido en este proceso. */
export function getBuildIdentity(): BuildIdentity {
  return resolveBuildIdentity(process.env);
}
