/**
 * lib/geo/cache.server.ts — caché TTL en memoria para geocoding.
 *
 * Evita pagar/consumir cupo por la misma búsqueda repetida (el usuario vuelve a
 * pulsar "Ubicar en el mapa", recarga o reintenta). El proceso por réplica es
 * el mismo patrón que el rate limit: suficiente para el volumen de onboarding.
 *
 * La clave NUNCA se registra: contiene direcciones o coordenadas.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, Entry<T>>();

  constructor(options: { max?: number; ttlMs?: number } = {}) {
    this.max = options.max ?? 500;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Reinsertar mantiene el orden de uso (LRU aproximado con Map).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
