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
 *      commit             SHA del build, si la plataforma lo expone
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
  environment: RuntimeEnvironmentName;
  database: HealthDatabase;
  timestamp: string;
}

export interface HealthDependencies {
  /** Comprueba la base. Se inyecta para poder testear sin Postgres. */
  checkDatabase: () => Promise<HealthDatabase>;
  /** Mapa de variables (por defecto `process.env`). */
  env?: RuntimeEnvSource;
  /** SHA del build; `null` si la plataforma no lo expone. */
  commit?: string | null;
  /** Reloj inyectable (tests). */
  now?: () => Date;
}

/** Timeout del `SELECT 1`. Un healthcheck no debe colgar el chequeo de Railway. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

/** SHA del commit, si el hosting lo expone (Vercel y Railway usan nombres distintos). */
export function resolveBuildCommit(source: RuntimeEnvSource = process.env): string | null {
  const candidates = [
    source.VERCEL_GIT_COMMIT_SHA,
    source.RAILWAY_GIT_COMMIT_SHA,
    source.GIT_COMMIT_SHA,
    source.GIT_COMMIT,
  ];
  for (const value of candidates) {
    const commit = typeof value === 'string' ? value.trim() : '';
    if (commit) return commit;
  }
  return null;
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

  return {
    ok: database.reachable,
    version: pkg.version,
    commit: deps.commit !== undefined ? deps.commit : resolveBuildCommit(env),
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
