/**
 * Uniswap V4 pool registry subgraph on The Graph (default `6XvRX3WHSvzBVTiPdF66XSBVbxWuHqijWANbjJxRDyzr`,
 * "Uniswap V4 Ethereum"). It indexes PoolManager `Initialize` events only: poolId, currencies,
 * fee, tickSpacing, hooks, block and timestamp. No TVL/volume/prices. It is a simpler deployment
 * than the official analytics subgraph (no swap handlers), so it keeps working when the official
 * one breaks — e.g. the 2026-10-31 `handleSwap` "unexpected null" outage.
 */
import { McpToolError } from '../errors.js';
import type { FetchLike } from './http.js';

export interface RegistryPool {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  blockNumber: string;
  blockTimestamp: string;
}

const FIELDS = 'poolId currency0 currency1 fee tickSpacing hooks blockNumber blockTimestamp';
const ZERO = '0x0000000000000000000000000000000000000000';

export class PoolRegistryClient {
  constructor(
    private readonly options: {
      gatewayUrl: string;
      apiKey: string | undefined;
      subgraphId: string;
      fetch: FetchLike;
    }
  ) {}

  get configured(): boolean {
    return !!this.options.apiKey && !!this.options.subgraphId;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.configured) {
      throw new McpToolError(
        'NOT_CONFIGURED',
        'THEGRAPH_API_KEY is not set; the pool registry is unavailable',
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
        `Pool registry subgraph request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const body = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string }[];
    } | null;
    if (!response.ok || !body || body.errors?.length || !body.data) {
      const reason = body?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${response.status}`;
      throw new McpToolError(
        'SUBGRAPH_UNAVAILABLE',
        `Pool registry subgraph error: ${reason.slice(0, 300)}`
      );
    }
    return body.data;
  }

  async meta(): Promise<{
    blockNumber: number;
    blockTimestamp: number | null;
    hasIndexingErrors: boolean;
  }> {
    const data = await this.query<{
      _meta: { block: { number: number; timestamp: number | null }; hasIndexingErrors: boolean };
    }>('{ _meta { block { number timestamp } hasIndexingErrors } }', {});
    return {
      blockNumber: data._meta.block.number,
      blockTimestamp: data._meta.block.timestamp,
      hasIndexingErrors: data._meta.hasIndexingErrors,
    };
  }

  /** Pools for a currency pair (addresses lowercase, currency0 < currency1). */
  async pairPools(currency0: string, currency1: string, first = 50): Promise<RegistryPool[]> {
    const data = await this.query<{ pools: RegistryPool[] }>(
      `query($c0: Bytes!, $c1: Bytes!, $first: Int!) {
        pools(first: $first, orderBy: blockTimestamp, orderDirection: asc, where: { currency0: $c0, currency1: $c1 }) { ${FIELDS} }
      }`,
      { c0: currency0.toLowerCase(), c1: currency1.toLowerCase(), first }
    );
    return data.pools;
  }

  /** Pools with a non-zero hook created since `sinceUnix`, newest first. */
  async newHookPools(args: {
    sinceUnix: number;
    first: number;
    pair?: [string, string];
  }): Promise<RegistryPool[]> {
    const pairFilter = args.pair ? ', currency0: $c0, currency1: $c1' : '';
    const pairVars = args.pair ? ', $c0: Bytes!, $c1: Bytes!' : '';
    const data = await this.query<{ pools: RegistryPool[] }>(
      `query($zero: Bytes!, $since: BigInt!, $first: Int!${pairVars}) {
        pools(first: $first, orderBy: blockTimestamp, orderDirection: desc, where: { hooks_not: $zero, blockTimestamp_gte: $since${pairFilter} }) { ${FIELDS} }
      }`,
      {
        zero: ZERO,
        since: String(args.sinceUnix),
        first: args.first,
        ...(args.pair ? { c0: args.pair[0].toLowerCase(), c1: args.pair[1].toLowerCase() } : {}),
      }
    );
    return data.pools;
  }

  /** Pools using a hook, oldest first. */
  async poolsByHook(hook: string, first = 100): Promise<RegistryPool[]> {
    const data = await this.query<{ pools: RegistryPool[] }>(
      `query($hook: Bytes!, $first: Int!) {
        pools(first: $first, orderBy: blockTimestamp, orderDirection: asc, where: { hooks: $hook }) { ${FIELDS} }
      }`,
      { hook: hook.toLowerCase(), first }
    );
    return data.pools;
  }
}
