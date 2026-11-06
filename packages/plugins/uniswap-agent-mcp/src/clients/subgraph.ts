/**
 * Official Uniswap v4 subgraph (Ethereum mainnet, read-only market data) through The Graph
 * gateway. Queries use only entities/fields from docs/vendor/uniswap-v4-subgraph-schema.graphql.
 * Every response also reads `_meta` so tools can report indexing lag (`asOf`).
 */
import { McpToolError } from '../errors.js';
import type { FetchLike } from './http.js';

export interface SubgraphMeta {
  blockNumber: number;
  blockTimestamp: number | null;
  hasIndexingErrors: boolean;
}

export interface SgToken {
  id: string;
  symbol: string;
  decimals: string;
}

export interface SgPool {
  id: string;
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  totalValueLockedUSD: string;
  createdAtTimestamp: string;
  createdAtBlockNumber: string;
  token0: SgToken;
  token1: SgToken;
}

export interface SgPoolDayData {
  date: number;
  pool: { id: string };
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
}

export interface SgPricePoint {
  ts: number;
  token0Price?: string;
  token1Price?: string;
  priceUSD?: string;
}

const POOL_FIELDS = `
  id feeTier tickSpacing hooks totalValueLockedUSD createdAtTimestamp createdAtBlockNumber
  token0 { id symbol decimals }
  token1 { id symbol decimals }
`;
const META = `_meta { block { number timestamp } hasIndexingErrors }`;

export interface SubgraphOptions {
  gatewayUrl: string;
  apiKey: string | undefined;
  subgraphId: string;
  fetch: FetchLike;
}

export class SubgraphClient {
  constructor(private readonly options: SubgraphOptions) {}

  get configured(): boolean {
    return !!this.options.apiKey;
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T & { _meta: RawMeta }> {
    if (!this.options.apiKey) {
      throw new McpToolError(
        'NOT_CONFIGURED',
        'THEGRAPH_API_KEY is not set; the v4 subgraph is unavailable.',
        {
          retryable: false,
        }
      );
    }
    const url = `${this.options.gatewayUrl}/${this.options.apiKey}/subgraphs/id/${this.options.subgraphId}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new McpToolError(
        'SUBGRAPH_UNAVAILABLE',
        `Uniswap v4 subgraph request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const body = (await response.json().catch(() => null)) as {
      data?: T & { _meta: RawMeta };
      errors?: { message: string }[];
    } | null;
    if (!response.ok || !body || body.errors?.length || !body.data) {
      const reason = body?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${response.status}`;
      throw new McpToolError(
        'SUBGRAPH_UNAVAILABLE',
        `Uniswap v4 subgraph error: ${reason.slice(0, 400)}`,
        {
          retryable: true,
        }
      );
    }
    return body.data;
  }

  async meta(): Promise<SubgraphMeta> {
    const data = await this.query<Record<string, never>>(`{ ${META} }`, {});
    return toMeta(data._meta);
  }

  /** Pools for a currency pair (ids lowercase, currency0 < currency1), deepest first. */
  async poolsForPair(
    token0: string,
    token1: string,
    first = 50
  ): Promise<{ pools: SgPool[]; meta: SubgraphMeta }> {
    const data = await this.query<{ pools: SgPool[] }>(
      `query($t0: String!, $t1: String!, $first: Int!) {
        pools(where: { token0: $t0, token1: $t1 }, orderBy: totalValueLockedUSD, orderDirection: desc, first: $first) { ${POOL_FIELDS} }
        ${META}
      }`,
      { t0: token0.toLowerCase(), t1: token1.toLowerCase(), first }
    );
    return { pools: data.pools, meta: toMeta(data._meta) };
  }

  async poolDayData(poolIds: string[], sinceUnix: number): Promise<SgPoolDayData[]> {
    if (poolIds.length === 0) return [];
    const data = await this.query<{ poolDayDatas: SgPoolDayData[] }>(
      `query($ids: [String!]!, $since: Int!) {
        poolDayDatas(where: { pool_in: $ids, date_gte: $since }, orderBy: date, orderDirection: asc, first: 1000) {
          date pool { id } volumeUSD feesUSD tvlUSD
        }
        ${META}
      }`,
      { ids: poolIds, since: sinceUnix }
    );
    return data.poolDayDatas;
  }

  /** Pools with a non-zero hook created since `sinceUnix`, newest first. */
  async newHookPools(args: {
    sinceUnix: number;
    first: number;
    pair?: [string, string];
  }): Promise<{ pools: SgPool[]; meta: SubgraphMeta }> {
    const pairFilter = args.pair ? ', token0: $t0, token1: $t1' : '';
    const pairVars = args.pair ? ', $t0: String!, $t1: String!' : '';
    const data = await this.query<{ pools: SgPool[] }>(
      `query($zero: String!, $since: BigInt!, $first: Int!${pairVars}) {
        pools(where: { hooks_not: $zero, createdAtTimestamp_gte: $since${pairFilter} }, orderBy: createdAtTimestamp, orderDirection: desc, first: $first) { ${POOL_FIELDS} }
        ${META}
      }`,
      {
        zero: '0x0000000000000000000000000000000000000000',
        since: String(args.sinceUnix),
        first: args.first,
        ...(args.pair ? { t0: args.pair[0].toLowerCase(), t1: args.pair[1].toLowerCase() } : {}),
      }
    );
    return { pools: data.pools, meta: toMeta(data._meta) };
  }

  async poolsByHook(hook: string, first = 100): Promise<{ pools: SgPool[]; meta: SubgraphMeta }> {
    const data = await this.query<{ pools: SgPool[] }>(
      `query($hook: String!, $first: Int!) {
        pools(where: { hooks: $hook }, orderBy: createdAtTimestamp, orderDirection: asc, first: $first) { ${POOL_FIELDS} }
        ${META}
      }`,
      { hook: hook.toLowerCase(), first }
    );
    return { pools: data.pools, meta: toMeta(data._meta) };
  }

  async poolPrices(
    poolId: string,
    interval: 'hour' | 'day',
    sinceUnix: number
  ): Promise<{ points: SgPricePoint[]; meta: SubgraphMeta }> {
    if (interval === 'hour') {
      const data = await this.query<{
        poolHourDatas: { periodStartUnix: number; token0Price: string; token1Price: string }[];
      }>(
        `query($pool: String!, $since: Int!) {
          poolHourDatas(where: { pool: $pool, periodStartUnix_gte: $since }, orderBy: periodStartUnix, orderDirection: asc, first: 1000) { periodStartUnix token0Price token1Price }
          ${META}
        }`,
        { pool: poolId, since: sinceUnix }
      );
      return {
        points: data.poolHourDatas.map((p) => ({
          ts: p.periodStartUnix,
          token0Price: p.token0Price,
          token1Price: p.token1Price,
        })),
        meta: toMeta(data._meta),
      };
    }
    const data = await this.query<{
      poolDayDatas: { date: number; token0Price: string; token1Price: string }[];
    }>(
      `query($pool: String!, $since: Int!) {
        poolDayDatas(where: { pool: $pool, date_gte: $since }, orderBy: date, orderDirection: asc, first: 1000) { date token0Price token1Price }
        ${META}
      }`,
      { pool: poolId, since: sinceUnix }
    );
    return {
      points: data.poolDayDatas.map((p) => ({
        ts: p.date,
        token0Price: p.token0Price,
        token1Price: p.token1Price,
      })),
      meta: toMeta(data._meta),
    };
  }

  async tokenPrices(
    tokenId: string,
    interval: 'hour' | 'day',
    sinceUnix: number
  ): Promise<{ points: SgPricePoint[]; meta: SubgraphMeta }> {
    if (interval === 'hour') {
      const data = await this.query<{
        tokenHourDatas: { periodStartUnix: number; priceUSD: string }[];
      }>(
        `query($token: String!, $since: Int!) {
          tokenHourDatas(where: { token: $token, periodStartUnix_gte: $since }, orderBy: periodStartUnix, orderDirection: asc, first: 1000) { periodStartUnix priceUSD }
          ${META}
        }`,
        { token: tokenId.toLowerCase(), since: sinceUnix }
      );
      return {
        points: data.tokenHourDatas.map((p) => ({ ts: p.periodStartUnix, priceUSD: p.priceUSD })),
        meta: toMeta(data._meta),
      };
    }
    const data = await this.query<{ tokenDayDatas: { date: number; priceUSD: string }[] }>(
      `query($token: String!, $since: Int!) {
        tokenDayDatas(where: { token: $token, date_gte: $since }, orderBy: date, orderDirection: asc, first: 1000) { date priceUSD }
        ${META}
      }`,
      { token: tokenId.toLowerCase(), since: sinceUnix }
    );
    return {
      points: data.tokenDayDatas.map((p) => ({ ts: p.date, priceUSD: p.priceUSD })),
      meta: toMeta(data._meta),
    };
  }
}

interface RawMeta {
  block: { number: number; timestamp: number | null };
  hasIndexingErrors: boolean;
}

function toMeta(raw: RawMeta | undefined): SubgraphMeta {
  return {
    blockNumber: raw?.block.number ?? 0,
    blockTimestamp: raw?.block.timestamp ?? null,
    hasIndexingErrors: raw?.hasIndexingErrors ?? false,
  };
}
