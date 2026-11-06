/**
 * get_price_history — USD price series from the official Uniswap v4 mainnet subgraph.
 * ETH uses the deepest native-ETH/USDC v4 pool (PoolHourData / PoolDayData token prices);
 * other symbols use TokenHourData / TokenDayData.priceUSD. Reports subgraph lag (`asOf`).
 */
import { Decimal } from '../amounts.js';
import { cacheKey, TTL } from '../cache.js';
import { MAINNET_CHAIN_ID, NATIVE_ADDRESS, requireChainAddress } from '../chains.js';
import type { SgPricePoint, SubgraphMeta } from '../clients/subgraph.js';
import { invalidInput, McpToolError } from '../errors.js';
import { GetPriceHistoryInputSchema, GetPriceHistoryOutputSchema } from '../schemas.js';
import { defineTool } from './define.js';

const WINDOW_SECONDS = { '1h': 3_600, '24h': 86_400, '7d': 604_800 } as const;
/** Data older than this (vs now) is flagged stale. */
export const STALE_AFTER_SECONDS = 2 * 3_600;

export const getPriceHistoryTool = defineTool({
  name: 'get_price_history',
  title: 'Price history (v4 subgraph)',
  description:
    'USD price history for a token from the official Uniswap v4 subgraph on Ethereum mainnet. ETH comes from the deepest ETH/USDC v4 pool; other allowlisted symbols from token hour/day data. window: 1h | 24h | 7d, interval: hour | day. Returns the series plus open/close/high/low/changePct and asOf (last indexed block time) with a stale flag, because the subgraph can lag. Read-only.',
  kind: 'read',
  input: GetPriceHistoryInputSchema,
  output: GetPriceHistoryOutputSchema,
  async handler(args, deps) {
    const symbol = args.symbol.toUpperCase();
    if (args.interval === 'day' && args.window === '1h') {
      throw invalidInput('interval "day" cannot be used with window "1h"; use interval "hour"');
    }
    const nowSec = Math.floor(deps.now() / 1000);
    const windowStart = nowSec - WINDOW_SECONDS[args.window];
    const since =
      args.interval === 'day'
        ? windowStart - (windowStart % 86_400)
        : windowStart - (windowStart % 3_600);

    const loaded = await deps.cache.wrap(
      cacheKey('price-history', { symbol, w: args.window, i: args.interval, since }),
      TTL.poolStats,
      async () => {
        if (symbol === 'ETH' || symbol === 'WETH') {
          const usdc = requireChainAddress(MAINNET_CHAIN_ID, 'usdc');
          const { pools } = await deps.subgraph.poolsForPair(NATIVE_ADDRESS, usdc, 5);
          const pool = pools[0];
          if (!pool)
            throw new McpToolError('POOL_NOT_FOUND', 'No ETH/USDC v4 pool found in the subgraph', {
              retryable: false,
            });
          const { points, meta } = await deps.subgraph.poolPrices(pool.id, args.interval, since);
          const ethIsToken0 = pool.token0.id.toLowerCase() === NATIVE_ADDRESS;
          return {
            source: {
              kind: 'pool' as const,
              id: pool.id,
              description: `Uniswap v4 ETH/USDC pool (fee ${pool.feeTier}, TVL $${Math.round(
                Number(pool.totalValueLockedUSD)
              ).toLocaleString('en-US')})`,
            },
            // v4 subgraph: token1Price = token1 per token0. ETH is currency0 → USDC per ETH = token1Price.
            series: points.map((p: SgPricePoint) => ({
              ts: p.ts,
              price: (ethIsToken0 ? p.token1Price : p.token0Price) ?? '0',
            })),
            meta,
          };
        }
        const token = deps.tokens.mainnetToken(symbol);
        if (!token) {
          throw new McpToolError(
            'UNKNOWN_TOKEN',
            `No mainnet reference token for "${symbol}" (allowlist it in TOKEN_ALLOWLIST_JSON for chain 1)`,
            {
              retryable: false,
            }
          );
        }
        const { points, meta } = await deps.subgraph.tokenPrices(
          token.address,
          args.interval,
          since
        );
        return {
          source: {
            kind: 'token' as const,
            id: token.address.toLowerCase(),
            description: `Uniswap v4 subgraph ${symbol} ${args.interval} data`,
          },
          series: points.map((p: SgPricePoint) => ({ ts: p.ts, price: p.priceUSD ?? '0' })),
          meta,
        };
      }
    );

    const series = loaded.series
      .filter((p) => new Decimal(p.price).gt(0))
      .map((p) => ({
        ts: new Date(p.ts * 1000).toISOString(),
        priceUsd: new Decimal(p.price).toDecimalPlaces(6).toFixed(),
      }));
    const values = series.map((p) => new Decimal(p.priceUsd));
    const open = values[0] ?? null;
    const close = values.at(-1) ?? null;
    const meta: SubgraphMeta = loaded.meta;
    const lag = meta.blockTimestamp !== null ? Math.max(0, nowSec - meta.blockTimestamp) : null;
    return {
      symbol,
      window: args.window,
      interval: args.interval,
      source: loaded.source,
      series,
      open: open?.toFixed() ?? null,
      close: close?.toFixed() ?? null,
      high: values.length ? Decimal.max(...values).toFixed() : null,
      low: values.length ? Decimal.min(...values).toFixed() : null,
      changePct:
        open && close && open.gt(0)
          ? close.minus(open).div(open).mul(100).toDecimalPlaces(2).toFixed()
          : null,
      asOf:
        meta.blockTimestamp !== null ? new Date(meta.blockTimestamp * 1000).toISOString() : null,
      lagSeconds: lag,
      stale: lag === null || lag > STALE_AFTER_SECONDS || meta.hasIndexingErrors,
      hasIndexingErrors: meta.hasIndexingErrors,
    };
  },
  summarize(o) {
    if (o.series.length === 0)
      return `No ${o.symbol} price data for ${o.window} (subgraph asOf ${o.asOf ?? 'unknown'}).`;
    return `${o.symbol} ${o.window}: $${o.open} → $${o.close} (${o.changePct}%), high $${
      o.high
    }, low $${o.low}; ${o.series.length} ${o.interval} points; asOf ${o.asOf}${
      o.stale ? ' (STALE)' : ''
    }.`;
  },
});
