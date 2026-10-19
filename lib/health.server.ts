/**
 * lib/health.server.ts — reporte de salud para Railway/Vercel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ DEVUELVE (y qué NO)
 *
 *  Sólo datos operativos y NO secretos:
 *
 *      ok                 true si la base respondió
 *      version            versión de la app (package.json)
 *      commit             SHA del build realmente desplegado
 *      build.id           id único del build (se sella al compilar)
 *      build.commitSource de dónde salió el SHA (`git`, `BUILD_COMMIT`…)
 *      build.builtAt      ISO 8601 del build
 *      environment        APP_ENV resuelto (production | staging | preview | development)
 *      database.reachable true/false
 *      database.type      driver en uso (`neon`, `pg` o `none`)
 *      timestamp          ISO 8601 del momento de la consulta
 *
 *  NUNCA: URL de conexión, usuario, password, host, nombre de base, tokens ni
 *  variables de entorno. El healthcheck puede quedar público sin filtrar nada.
 *
 *  El chequeo es UNA consulta `SELECT 1` con timeout corto: barato y suficiente
 *  para que Railway reinicie el servicio si la base dejó de responder.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import pkg from '../package.json';
import { resolveBuildIdentity, type BuildIdentity } from './build-info';
import { getDatabaseUrl } from './db';
import { resolveDbDriver, type DbDriverName } from './db-driver.server';
import {
  resolveRuntimeEnvironment,
  type RuntimeEnvironmentName,
  type RuntimeEnvSource,
} from './runtime-environment.server';

/** Tipo reportado cuando no hay connection string configurada. */
export type HealthDatabaseType = DbDriverName | 'none';

export interface HealthDatabase {
  reachable: boolean;
  type: HealthDatabaseType;
}

export interface HealthReport {
  ok: boolean;
  version: string;
  commit: string | null;
  /** Identidad del build embebida al compilar. Siempre presente. */
  build: Pick<BuildIdentity, 'buildId' | 'commitSource' | 'builtAt'>;
  environment: RuntimeEnvironmentName;
  database: HealthDatabase;
  timestamp: string;
}

export interface HealthDependencies {
  /** Comprueba la base. Se inyecta para poder testear sin Postgres. */
  checkDatabase: () => Promise<HealthDatabase>;
  /** Mapa de variables (por defecto `process.env`). */
  env?: RuntimeEnvSource;
  /** SHA del build; `null` si no se pudo resolver. */
  commit?: string | null;
  /** Identidad del build inyectable (tests). */
  build?: BuildIdentity;
  /** Reloj inyectable (tests). */
  now?: () => Date;
}

/** Timeout del `SELECT 1`. Un healthcheck no debe colgar el chequeo de Railway. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

/**
 * SHA del commit.
 *
 * La fuente principal es el manifiesto sellado en build (`lib/build-info.ts`),
 * justamente porque `RAILWAY_GIT_COMMIT_SHA` queda viejo con `railway up`. Las
 * variables de plataforma siguen como último recurso.
 */
export function resolveBuildCommit(source: RuntimeEnvSource = process.env): string | null {
  return resolveBuildIdentity(source).commit;
}

/** Ejecuta una promesa con timeout, sin dejar timers colgados. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health_db_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Chequeo real: `SELECT 1` sobre el mismo cliente SQL que usa la app.
 *
 * La importación de `./db` es diferida a propósito para que los tests del
 * reporte no necesiten una base ni una URL.
 */
export async function checkDatabaseReachable(): Promise<HealthDatabase> {
  const url = getDatabaseUrl();
  if (!url) return { reachable: false, type: 'none' };

  let type: DbDriverName;
  try {
    type = resolveDbDriver(url, process.env.DB_DRIVER);
  } catch {
    // DB_DRIVER inválido: la app ya falla cerrado al conectar; el health lo reporta.
    return { reachable: false, type: 'none' };
  }

  const { sql } = await import('./db');
  if (!sql) return { reachable: false, type };

  try {
    await withTimeout(Promise.resolve(sql`SELECT 1 AS ok`), HEALTH_DB_TIMEOUT_MS);
    return { reachable: true, type };
  } catch {
    return { reachable: false, type };
  }
}

/** Construye el reporte. Puro salvo por `checkDatabase`. */
export async function buildHealthReport(deps: HealthDependencies): Promise<HealthReport> {
  const env = deps.env ?? process.env;
  const database = await deps.checkDatabase();
  const now = deps.now ? deps.now() : new Date();
  const identity = deps.build ?? resolveBuildIdentity(env);

  return {
    ok: database.reachable,
    version: pkg.version,
    commit: deps.commit !== undefined ? deps.commit : identity.commit,
    build: {
      buildId: identity.buildId,
      commitSource: identity.commitSource,
      builtAt: identity.builtAt,
    },
    environment: resolveRuntimeEnvironment(env).name,
    database,
    timestamp: now.toISOString(),
  };
}

/**
 * Respuesta HTTP del healthcheck: 200 si la base responde, 503 si no.
 * `Cache-Control: no-store` evita que un CDN cachee una caída o una recuperación.
 */
export async function healthResponse(deps: HealthDependencies): Promise<Response> {
  const report = await buildHealthReport(deps);
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
