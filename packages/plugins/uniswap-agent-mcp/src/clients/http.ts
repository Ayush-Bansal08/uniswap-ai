/**
 * Resilient fetch used by every HTTP client: per-attempt timeout (10 s default), and up to 3
 * retries with exponential backoff + jitter on 429 / 5xx / network errors (swap-integration
 * skill "Rate Limiting"; LP guide "Error recovery"). Non-retryable statuses are returned as-is
 * so callers can map Uniswap error bodies.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResilientFetchOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry (for logging); never receives request bodies or headers. */
  onRetry?: (info: {
    url: string;
    attempt: number;
    status: number | null;
    delayMs: number;
  }) => void;
}

export class HttpTimeoutError extends Error {
  override name = 'HttpTimeoutError';
}

export class HttpNetworkError extends Error {
  override name = 'HttpNetworkError';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Returns a fetch with timeout + retry semantics. Bodies must be strings (re-sendable). */
export function createResilientFetch(options: ResilientFetchOptions = {}): FetchLike {
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;

  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // openapi-fetch hands us a Request; copy it so it can be re-sent on retry.
    const template = input instanceof Request ? input : null;
    const templateBody = template && template.body ? await template.clone().text() : undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const signal = AbortSignal.timeout(timeoutMs);
      let status: number | null = null;
      try {
        const response = template
          ? await baseFetch(template.url, {
              method: template.method,
              headers: template.headers,
              body: templateBody,
              signal,
            })
          : await baseFetch(input, { ...init, signal });
        status = response.status;
        if (!isRetryableStatus(response.status) || attempt === maxRetries) return response;
        // Drain so the connection can be reused.
        await response.arrayBuffer().catch(() => undefined);
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
        lastError = isTimeout
          ? new HttpTimeoutError(`Request to ${new URL(url).host} timed out after ${timeoutMs} ms`)
          : new HttpNetworkError(
              `Request to ${new URL(url).host} failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
        if (attempt === maxRetries) throw lastError;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100), 5_000);
      options.onRetry?.({ url, attempt: attempt + 1, status, delayMs });
      await sleep(delayMs);
    }
    throw lastError instanceof Error ? lastError : new Error('Request failed');
  };
}
