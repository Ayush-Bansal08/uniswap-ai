/**
 * get_price_history — USD price series for an allowlisted token on Ethereum mainnet.
 *
 * Sources, with automatic failover (src/market/data.ts `priceSeries`):
 *   1. official Uniswap v4 subgraph (PoolHourData/PoolDayData for ETH, TokenHour/DayData otherwise)
 *   2. Uniswap v4 StateView read on-chain at historical blocks (archive RPC) on the deepest
 *      hookless v4 <token>/USDC pool — Uniswap contracts only, no indexer
 *   3. GeckoTerminal OHLCV for the deepest Uniswap v4 pool (third party)
 * `source.provider` says which one answered; `asOf`/`lagSeconds`/`stale` describe freshness.
 */
import { Decimal } from '../amounts.js';
import { invalidInput } from '../errors.js';
import { priceSeries } from '../market/data.js';
import { GetPriceHistoryInputSchema, GetPriceHistoryOutputSchema } from '../schemas.js';
import { defineTool } from './define.js';

const WINDOW_SECONDS = { '1h': 3_600, '24h': 86_400, '7d': 604_800 } as const;
/** Data older than this (vs now) is flagged stale. */
export const STALE_AFTER_SECONDS = 2 * 3_600;

export const getPriceHistoryTool = defineTool({
  name: 'get_price_history',
  title: 'Price history (Uniswap v4, mainnet)',
  description:
    'USD price history for a token on Ethereum mainnet from Uniswap v4: the official v4 subgraph, failing over to on-chain StateView reads at historical blocks on the deepest hookless v4 pool, then GeckoTerminal candles. window: 1h | 24h | 7d, interval: hour | day. Returns the series, open/close/high/low/changePct, and asOf/lagSeconds/stale. source.provider names the source used. Read-only.',
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
    const step = args.interval === 'day' ? 86_400 : 3_600;
    const since = windowStart - (windowStart % step);

    const loaded = await priceSeries(deps, { symbol, interval: args.interval, sinceUnix: since });
    const series = loaded.data.points
      .filter((p) => new Decimal(p.price).gt(0))
      .map((p) => ({
        ts: new Date(p.ts * 1000).toISOString(),
        priceUsd: new Decimal(p.price).toDecimalPlaces(6).toFixed(),
      }));
    const values = series.map((p) => new Decimal(p.priceUsd));
    const open = values[0] ?? null;
    const close = values.at(-1) ?? null;
    const lag = loaded.data.lagSeconds;
    const errors = loaded.data.hasIndexingErrors;
    return {
      symbol,
      window: args.window,
      interval: args.interval,
      source: {
        kind: loaded.data.sourceKind,
        id: loaded.data.sourceId,
        description: loaded.data.description,
        provider: loaded.source,
      },
      series,
      open: open?.toFixed() ?? null,
      close: close?.toFixed() ?? null,
      high: values.length ? Decimal.max(...values).toFixed() : null,
      low: values.length ? Decimal.min(...values).toFixed() : null,
      changePct:
        open && close && open.gt(0)
          ? close.minus(open).div(open).mul(100).toDecimalPlaces(2).toFixed()
          : null,
      asOf: loaded.asOf,
      lagSeconds: lag,
      stale: lag === null || lag > STALE_AFTER_SECONDS || errors === true,
      hasIndexingErrors: errors,
      warnings: loaded.warnings,
    };
  },
  summarize(o) {
    if (o.series.length === 0)
      return `No ${o.symbol} price data for ${o.window} (${o.source.provider}, asOf ${
        o.asOf ?? 'unknown'
      }).`;
    return `${o.symbol} ${o.window}: $${o.open} → $${o.close} (${o.changePct}%), high $${
      o.high
    }, low $${o.low}; ${o.series.length} ${o.interval} points via ${o.source.provider}; asOf ${
      o.asOf
    }${o.stale ? ' (STALE)' : ''}.`;
  },
});
