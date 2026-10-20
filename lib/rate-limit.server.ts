/**
 * lib/rate-limit.server.ts — límite de tasa con backend sustituible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ UNA INTERFAZ
 *
 *  Antes el límite era un `Map` suelto dentro de las rutas: cambiar a Redis/KV
 *  obligaba a tocar todas. Ahora las rutas llaman `enforceRateLimit(request,
 *  scope, options)` y el backend se elige en un solo lugar.
 *
 *  · `memory` (default): sin dependencias ni costo. Suficiente para desarrollo,
 *    staging y una sola réplica. NO es global: con N réplicas cada una lleva su
 *    cuenta, así que el límite efectivo se multiplica por N.
 *  · `distributed` (futuro): cualquier implementación de `RateLimitProvider`
 *    registrada con `setRateLimitProvider()`. El contrato es async justamente
 *    para que Redis/KV encaje sin cambiar las rutas.
 *
 *  FAIL-CLOSED: si el provider distribuido falla, la ruta NO queda abierta. El
 *  helper devuelve `allowed: false` con `retryAfterSeconds` conservador y emite
 *  un evento seguro (sin IP ni clave) para diagnóstico.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logSecurityEvent } from './observability.server';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitProvider {
  /** Nombre estable para logs (`memory`, `redis`, `kv`…). */
  readonly name: string;
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  reset?(): Promise<void>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_KEYS = 5_000;

/**
 * Provider en memoria. Se mantiene como clase (no como funciones sueltas) para
 * poder instanciar uno limpio en tests y para que el estado no sea global
 * implícito.
 */
export class MemoryRateLimitProvider implements RateLimitProvider {
  readonly name = 'memory';
  private buckets = new Map<string, Bucket>();

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (this.buckets.size > MAX_KEYS) this.pruneExpired(now);
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - existing.count),
      retryAfterSeconds: 0,
    };
  }

  async reset(): Promise<void> {
    this.buckets.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
      if (this.buckets.size <= MAX_KEYS / 2) break;
    }
  }
}

const memoryProvider = new MemoryRateLimitProvider();
let activeProvider: RateLimitProvider = memoryProvider;

/**
 * Sustituye el backend. Una implementación distribuida debe ser idempotente y
 * devolver los mismos campos. Se llama una sola vez al arrancar el proceso.
 */
export function setRateLimitProvider(provider: RateLimitProvider): void {
  activeProvider = provider;
}

export function getRateLimitProviderName(): string {
  return activeProvider.name;
}

/** Para tests: vuelve al provider en memoria y lo vacía. */
export async function resetRateLimits(): Promise<void> {
  activeProvider = memoryProvider;
  await memoryProvider.reset();
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  /** Clave explícita (p. ej. `media:<userId>`) en vez de IP + scope. */
  key?: string;
}

/**
 * Consume una unidad del cupo. Nunca lanza: un provider caído se traduce en
 * `allowed: false` (fail-closed) y un evento seguro.
 */
export async function enforceRateLimit(
  request: Request,
  scope: string,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const limit = options.limit ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const key = options.key ?? rateLimitKeyFor(request, scope);

  try {
    return await activeProvider.consume(key, limit, windowMs);
  } catch {
    logSecurityEvent('rate_limit_provider_failed', {
      scope,
      provider: activeProvider.name,
      requestId: request.headers.get('x-request-id'),
    });
    return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
  }
}

/**
 * Compatibilidad síncrona para scripts y tests que ya usaban `consumeRateLimit`.
 * Las rutas nuevas deben usar `enforceRateLimit` (async) para no atarse al
 * backend en memoria.
 */
export function consumeRateLimit(key: string, limit = 60, windowMs = 60_000): RateLimitResult {
  const now = Date.now();
  const provider = activeProvider;

  // El provider en memoria es el único síncrono; los distribuidos se usan vía
  // `enforceRateLimit`. Si hay uno registrado, se falla cerrado en vez de
  // inventar un resultado.
  if (!(provider instanceof MemoryRateLimitProvider)) {
    return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
  }

  // Acceso directo al mismo algoritmo para conservar la firma histórica.
  const buckets = (provider as unknown as { buckets: Map<string, Bucket> }).buckets;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - existing.count), retryAfterSeconds: 0 };
}

/**
 * Clave por ruta + IP. Se guarda solo el hash corto de la IP para no conservar
 * direcciones completas en memoria/logs; el objetivo es contar, no identificar.
 */
export function rateLimitKeyFor(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown';
  return `${scope}:${hashKey(ip)}`;
}

/** Hash no criptográfico y estable: suficiente para agrupar por cliente. */
function hashKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
