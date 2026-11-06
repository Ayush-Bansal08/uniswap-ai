/**
 * In-memory LRU cache with per-entry TTL, plus single-flight de-duplication so concurrent
 * identical reads share one upstream request. Only read-only results are cached.
 */
import { LRUCache } from 'lru-cache';

/** TTLs per data class (PHASE 02 §1). */
export const TTL = Object.freeze({
  quote: 15_000,
  referencePrice: 30_000,
  poolStats: 5 * 60_000,
  hooks: 5 * 60_000,
  tokenMetadata: 24 * 60 * 60_000,
  unsupportedList: 24 * 60 * 60_000,
  deployBlock: 24 * 60 * 60_000,
});

export class TtlCache {
  // Expiry is tracked against the injected clock (lru-cache memoises its own clock reads).
  private readonly lru: LRUCache<string, { value: unknown; expiresAt: number }>;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(max = 5_000, private readonly now: () => number = Date.now) {
    this.lru = new LRUCache({ max });
  }

  private live(key: string): { value: unknown } | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.lru.delete(key);
      return undefined;
    }
    return entry;
  }

  get<T>(key: string): T | undefined {
    return this.live(key)?.value as T | undefined;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.lru.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Return the cached value or compute it once (concurrent callers await the same promise). */
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const hit = this.live(key);
    if (hit) return hit.value as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = compute()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.lru.clear();
    this.inflight.clear();
  }
}

/** Stable cache key for a JSON-able value (sorted object keys). */
export function cacheKey(prefix: string, value: unknown): string {
  return `${prefix}:${stableStringify(value)}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
