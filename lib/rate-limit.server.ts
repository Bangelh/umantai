/**
 * lib/rate-limit.server.ts — límite simple en memoria para las escrituras de admin.
 *
 * POR QUÉ EN MEMORIA
 *   No hay Redis/KV en el stack todavía y las mutaciones de inventario son de bajo
 *   volumen. Este límite frena ráfagas y dobles clics en UNA instancia; no es una
 *   garantía distribuida (con varias réplicas cada una lleva su cuenta). La
 *   idempotencia real la da el ledger (`inventory_movements.idempotency_key`).
 *
 * Si más adelante se necesita global, se cambia por Upstash/KV sin tocar las rutas.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 2000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function consumeRateLimit(
  key: string,
  limit = 60,
  windowMs = 60_000,
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > MAX_KEYS) pruneExpired(now);
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
    if (buckets.size <= MAX_KEYS / 2) break;
  }
}

/** Clave por ruta + IP (nunca por token: no se guardan secretos en memoria). */
export function rateLimitKeyFor(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown';
  return `${scope}:${ip}`;
}

/** Solo para tests. */
export function resetRateLimits(): void {
  buckets.clear();
}
