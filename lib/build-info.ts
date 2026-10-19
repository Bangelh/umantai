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
 *   2. manifiesto      → lo resuelto al compilar (git / Vercel / Railway).
 *   3. variables de plataforma en runtime → último recurso, y se marca como tal.
 *
 * Nunca se inventa un SHA: si no hay dato, `commit` es `null`.
 */

import manifestJson from './build-info.generated.json';

export interface BuildManifest {
  buildId: string;
  commit: string | null;
  commitSource: string;
  builtAt: string | null;
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
}

/** Manifiesto por defecto versionado en el repo (se sobrescribe en cada build). */
export const DEFAULT_BUILD_MANIFEST: BuildManifest = {
  buildId: 'dev',
  commit: null,
  commitSource: 'none',
  builtAt: null,
};

const PLATFORM_COMMIT_VARS = [
  'VERCEL_GIT_COMMIT_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'GIT_COMMIT',
] as const;

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resuelve la identidad del build. Puro: recibe env y manifiesto para poder
 * testear todos los casos sin tocar el proceso ni el sistema de archivos.
 */
export function resolveBuildIdentity(
  env: RuntimeEnvSource = process.env,
  manifest: BuildManifest = manifestJson as BuildManifest,
): BuildIdentity {
  const explicit = clean(env.BUILD_COMMIT);
  if (explicit) {
    return {
      buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
      commit: explicit,
      commitSource: 'BUILD_COMMIT',
      builtAt: manifest.builtAt ?? null,
    };
  }

  if (manifest.commit) {
    return {
      buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
      commit: manifest.commit,
      commitSource: manifest.commitSource || 'build_manifest',
      builtAt: manifest.builtAt ?? null,
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
      };
    }
  }

  return {
    buildId: clean(env.BUILD_ID) || manifest.buildId || 'dev',
    commit: null,
    commitSource: 'none',
    builtAt: manifest.builtAt ?? null,
  };
}

/** Identidad del build embebido en este proceso. */
export function getBuildIdentity(): BuildIdentity {
  return resolveBuildIdentity(process.env);
}
