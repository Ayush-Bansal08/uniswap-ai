/**
 * GeckoTerminal public API (CoinGecko), used ONLY as a fallback market-data source when the
 * official Uniswap v4 subgraph is unavailable. It indexes Uniswap v4 on Ethereum under the dex id
 * `uniswap-v4-ethereum`; v4 pools are addressed by their poolId. Free, no key, rate-limited
 * (~30 req/min), responses cached 30–60 s upstream — we cache 5 min on top.
 */
import { McpToolError } from '../errors.js';
import type { FetchLike } from './http.js';

export const GECKO_V4_DEX = 'uniswap-v4-ethereum';

export interface GeckoPool {
  /** v4 poolId (lowercase). */
  poolId: string;
  name: string;
  dex: string;
  baseToken: string;
  quoteToken: string;
  reserveUsd: string | null;
  volume24hUsd: string | null;
  createdAt: string | null;
}

/** [timestamp, open, high, low, close, volumeUsd] */
export type GeckoCandle = [number, number, number, number, number, number];

interface RawPool {
  attributes: {
    address: string;
    name: string;
    reserve_in_usd?: string | null;
    volume_usd?: { h24?: string | null };
    pool_created_at?: string | null;
  };
  relationships: {
    dex: { data: { id: string } };
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
  };
}

const tokenOf = (id: string) => id.replace(/^[a-z0-9-]+_/, '').toLowerCase();

function toPool(raw: RawPool): GeckoPool {
  return {
    poolId: raw.attributes.address.toLowerCase(),
    name: raw.attributes.name,
    dex: raw.relationships.dex.data.id,
    baseToken: tokenOf(raw.relationships.base_token.data.id),
    quoteToken: tokenOf(raw.relationships.quote_token.data.id),
    reserveUsd: raw.attributes.reserve_in_usd ?? null,
    volume24hUsd: raw.attributes.volume_usd?.h24 ?? null,
    createdAt: raw.attributes.pool_created_at ?? null,
  };
}

export class GeckoTerminalClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      network: string;
      fetch: FetchLike;
      enabled: boolean;
    }
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.options.enabled) {
      throw new McpToolError('NOT_CONFIGURED', 'GeckoTerminal fallback is disabled', {
        retryable: false,
      });
    }
    const url = `${this.options.baseUrl}/networks/${this.options.network}${path}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        headers: { accept: 'application/json;version=20230302' },
      });
    } catch (err) {
      throw new McpToolError(
        'UPSTREAM_ERROR',
        `GeckoTerminal request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (response.status === 429) {
      throw new McpToolError('RATE_LIMITED', 'GeckoTerminal rate limit reached');
    }
    if (!response.ok) {
      throw new McpToolError(
        'UPSTREAM_ERROR',
        `GeckoTerminal HTTP ${response.status} for ${path}`,
        {
          retryable: response.status >= 500,
        }
      );
    }
    return (await response.json()) as T;
  }

  /** Top pools (page 1, ≤ 20) that contain `token`, any dex. */
  async tokenPools(token: string): Promise<GeckoPool[]> {
    const body = await this.get<{ data?: RawPool[] }>(
      `/tokens/${token.toLowerCase()}/pools?page=1`
    );
    return (body.data ?? []).map(toPool);
  }

  /** Up to 30 pools by id. */
  async pools(poolIds: string[]): Promise<GeckoPool[]> {
    if (poolIds.length === 0) return [];
    const out: GeckoPool[] = [];
    for (let i = 0; i < poolIds.length; i += 30) {
      const chunk = poolIds.slice(i, i + 30).map((p) => p.toLowerCase());
      const body = await this.get<{ data?: RawPool[] }>(`/pools/multi/${chunk.join(',')}`);
      out.push(...(body.data ?? []).map(toPool));
    }
    return out;
  }

  /** OHLCV candles in USD for one token of the pool, oldest first. */
  async ohlcv(
    poolId: string,
    timeframe: 'hour' | 'day',
    limit: number,
    token: 'base' | 'quote'
  ): Promise<GeckoCandle[]> {
    const body = await this.get<{ data?: { attributes?: { ohlcv_list?: GeckoCandle[] } } }>(
      `/pools/${poolId.toLowerCase()}/ohlcv/${timeframe}?aggregate=1&limit=${Math.min(
        1000,
        Math.max(1, limit)
      )}&currency=usd&token=${token}`
    );
    return [...(body.data?.attributes?.ohlcv_list ?? [])].sort((a, b) => a[0] - b[0]);
  }
}
