/**
 * Source health + failover for market data.
 *
 * Every market-data capability has an ordered list of independent sources. `failover` tries them
 * in order and returns the first success with the source's name. A source that fails (any error
 * except bad input) is put on a cooldown, so later calls skip it instantly instead of paying its
 * timeout again; a source can also be skipped up front by a `precheck` (e.g. the official
 * subgraph reporting `hasIndexingErrors`). `snapshot()` exposes the state for diagnostics.
 */
import { McpToolError } from '../errors.js';

export interface SourceState {
  name: string;
  status: 'up' | 'down' | 'unknown';
  downUntil: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
}

export class SourceHealth {
  private readonly states = new Map<
    string,
    { downUntil: number; lastError: string | null; lastSuccessAt: number | null }
  >();

  constructor(private readonly now: () => number, readonly cooldownMs: number) {}

  private state(name: string) {
    let s = this.states.get(name);
    if (!s) {
      s = { downUntil: 0, lastError: null, lastSuccessAt: null };
      this.states.set(name, s);
    }
    return s;
  }

  isDown(name: string): boolean {
    return this.state(name).downUntil > this.now();
  }

  markDown(name: string, reason: string, cooldownMs = this.cooldownMs): void {
    const s = this.state(name);
    s.downUntil = this.now() + cooldownMs;
    s.lastError = reason.slice(0, 300);
  }

  markUp(name: string): void {
    const s = this.state(name);
    s.downUntil = 0;
    s.lastSuccessAt = this.now();
  }

  lastError(name: string): string | null {
    return this.state(name).lastError;
  }

  snapshot(): SourceState[] {
    return [...this.states.entries()].map(([name, s]) => ({
      name,
      status: s.downUntil > this.now() ? 'down' : s.lastSuccessAt ? 'up' : 'unknown',
      downUntil: s.downUntil > this.now() ? new Date(s.downUntil).toISOString() : null,
      lastError: s.lastError,
      lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
    }));
  }
}

export interface SourceAttempt<T> {
  name: string;
  /** Human label used in tool outputs ("Uniswap v4 subgraph", …). */
  label: string;
  /** Return a reason to skip this source for this request (no cooldown), e.g. known indexing errors. */
  precheck?: () => Promise<string | null>;
  run: () => Promise<T>;
}

export interface FailoverResult<T> {
  value: T;
  source: string;
  label: string;
  /** Sources skipped or failed before the winner, with why. */
  skipped: { source: string; reason: string }[];
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function failover<T>(
  health: SourceHealth,
  capability: string,
  attempts: SourceAttempt<T>[]
): Promise<FailoverResult<T>> {
  const skipped: { source: string; reason: string }[] = [];
  for (const attempt of attempts) {
    if (health.isDown(attempt.name)) {
      skipped.push({
        source: attempt.name,
        reason: `cooling down after: ${health.lastError(attempt.name) ?? 'an earlier failure'}`,
      });
      continue;
    }
    try {
      const skip = attempt.precheck ? await attempt.precheck() : null;
      if (skip) {
        // Not a failure of the source (it may serve other requests): no cooldown.
        skipped.push({ source: attempt.name, reason: skip });
        continue;
      }
      const value = await attempt.run();
      health.markUp(attempt.name);
      return { value, source: attempt.name, label: attempt.label, skipped };
    } catch (err) {
      if (err instanceof McpToolError && err.code === 'INVALID_INPUT') throw err;
      const reason = reasonOf(err);
      health.markDown(attempt.name, reason);
      skipped.push({ source: attempt.name, reason });
    }
  }
  throw new McpToolError(
    'MARKET_DATA_UNAVAILABLE',
    `No market-data source could serve ${capability}: ${skipped
      .map((s) => `${s.source} (${s.reason.slice(0, 160)})`)
      .join('; ')}`,
    { retryable: true, details: { capability, skipped } }
  );
}

/** Warnings for tool outputs describing which sources were bypassed. */
export function fallbackWarnings(result: FailoverResult<unknown>): string[] {
  return result.skipped.map((s) => `Skipped ${s.source}: ${s.reason.slice(0, 200)}`);
}
