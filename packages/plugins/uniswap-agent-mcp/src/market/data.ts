/**
 * Mainnet market data with automatic failover, so no single upstream can take the tools down.
 *
 *   capability          sources, in order
 *   ------------------  -----------------------------------------------------------------------
 *   pairPools           uniswap-v4-subgraph → uniswap-v4-pool-registry (+ LP API reserves for TVL,
 *                       GeckoTerminal for volume) → geckoterminal discovery (+ LP API metadata)
 *   priceSeries         uniswap-v4-subgraph → uniswap-v4-stateview (archive slot0 reads on the
 *                       deepest hookless v4 pool vs USDC) → geckoterminal OHLCV
 *   hookPools           uniswap-v4-subgraph → uniswap-v4-pool-registry → poolmanager-logs (30 days)
 *   newHookPools        uniswap-v4-subgraph → uniswap-v4-pool-registry → poolmanager-logs (≤ 30 days)
 *
 * The official subgraph is skipped up front while it reports `hasIndexingErrors` (checked every
 * 5 min). Failed sources cool down (MARKET_SOURCE_COOLDOWN_MS). Results always carry `source`.
 */
import { getAddress, type Address, type Hex } from 'viem';
import { Decimal } from '../amounts.js';
import { cacheKey, TTL } from '../cache.js';
import {
  DYNAMIC_FEE_FLAG,
  getChain,
  MAINNET_CHAIN_ID,
  NATIVE_ADDRESS,
  requireChainAddress,
} from '../chains.js';
import { GECKO_V4_DEX, type GeckoPool } from '../clients/geckoterminal.js';
import type { RegistryPool } from '../clients/poolRegistry.js';
import type { SgPool } from '../clients/subgraph.js';
import type { ToolDeps } from '../context.js';
import { McpToolError } from '../errors.js';
import { isZeroHook } from '../hooks/permissions.js';
import { scanInitializeLogs } from '../services/initializeScan.js';
import { tryReferencePriceUsd } from '../services/prices.js';
import { priceFromSqrt } from '../v4/math.js';
import { failover, fallbackWarnings, type FailoverResult, type SourceAttempt } from './health.js';

export const SOURCES = Object.freeze({
  subgraph: { name: 'uniswap-v4-subgraph', label: 'Uniswap v4 subgraph (official)' },
  registry: { name: 'uniswap-v4-pool-registry', label: 'Uniswap V4 pool registry subgraph' },
  stateview: { name: 'uniswap-v4-stateview', label: 'Uniswap v4 StateView on-chain (archive RPC)' },
  lpApi: { name: 'uniswap-lp-api', label: 'Uniswap LP API /lp/pool_info reserves' },
  gecko: { name: 'geckoterminal', label: 'GeckoTerminal (third-party, uniswap-v4-ethereum)' },
  logs: { name: 'poolmanager-logs', label: 'Uniswap v4 PoolManager Initialize logs (RPC)' },
});

/** Logs fallback never scans more than this many days on mainnet. */
export const MAX_LOG_SCAN_DAYS = 30;
/** Pools enriched with GeckoTerminal 7-day volume (one request each). */
export const VOLUME_ENRICH_TOP = 5;
/** Max points for an on-chain price series (one archive call each). */
export const MAX_ONCHAIN_POINTS = 200;

export interface MarketPoolInfo {
  poolId: string;
  token0: Address;
  token1: Address;
  token0Symbol: string | null;
  token1Symbol: string | null;
  fee: number | null;
  tickSpacing: number | null;
  hooks: Address;
  createdAt: string | null;
  createdAtBlock: string | null;
  tvlUsd: string | null;
  volume7dUsd: string | null;
  fees7dUsd: string | null;
}

export interface MarketResult<T> {
  data: T;
  source: string;
  sourceLabel: string;
  asOf: string | null;
  warnings: string[];
}

const iso = (unix: number | string | null | undefined) =>
  unix === null || unix === undefined || unix === ''
    ? null
    : new Date(Number(unix) * 1000).toISOString();
const lower = (a: string) => a.toLowerCase();
const nowSec = (deps: ToolDeps) => Math.floor(deps.now() / 1000);

function result<T>(
  r: FailoverResult<{ data: T; asOf: string | null; warnings?: string[] }>
): MarketResult<T> {
  return {
    data: r.value.data,
    source: r.source,
    sourceLabel: r.label,
    asOf: r.value.asOf,
    warnings: [...fallbackWarnings(r), ...(r.value.warnings ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Source prechecks and mappers
// ---------------------------------------------------------------------------

/** Skip the official subgraph while it reports indexing errors (its data is withheld/untrusted). */
function officialPrecheck(deps: ToolDeps) {
  return async (): Promise<string | null> => {
    if (!deps.subgraph.configured) return 'THEGRAPH_API_KEY is not set';
    const meta = await deps.cache.wrap('sg-health', TTL.sourceHealth, () => deps.subgraph.meta());
    return meta.hasIndexingErrors
      ? 'official v4 subgraph reports hasIndexingErrors=true (indexers refuse to serve it)'
      : null;
  };
}

function fromSubgraph(p: SgPool): MarketPoolInfo {
  return {
    poolId: lower(p.id),
    token0: getAddress(p.token0.id),
    token1: getAddress(p.token1.id),
    token0Symbol: p.token0.symbol || null,
    token1Symbol: p.token1.symbol || null,
    fee: Number(p.feeTier),
    tickSpacing: Number(p.tickSpacing),
    hooks: /^0x[0-9a-fA-F]{40}$/.test(p.hooks) ? getAddress(p.hooks) : NATIVE_ADDRESS,
    createdAt: iso(p.createdAtTimestamp),
    createdAtBlock: p.createdAtBlockNumber ?? null,
    tvlUsd: new Decimal(p.totalValueLockedUSD || '0').toDecimalPlaces(2).toFixed(),
    volume7dUsd: null,
    fees7dUsd: null,
  };
}

function fromRegistry(p: RegistryPool): MarketPoolInfo {
  return {
    poolId: lower(p.poolId),
    token0: getAddress(p.currency0),
    token1: getAddress(p.currency1),
    token0Symbol: null,
    token1Symbol: null,
    fee: Number(p.fee),
    tickSpacing: Number(p.tickSpacing),
    hooks: getAddress(p.hooks),
    createdAt: iso(p.blockTimestamp),
    createdAtBlock: p.blockNumber,
    tvlUsd: null,
    volume7dUsd: null,
    fees7dUsd: null,
  };
}

/** Fill token symbols from the allowlist, then mainnet ERC-20 metadata (best effort). */
async function fillSymbols(deps: ToolDeps, pools: MarketPoolInfo[]): Promise<void> {
  const unknown = new Set<string>();
  for (const p of pools) {
    for (const [addr, key] of [
      [p.token0, 'token0Symbol'],
      [p.token1, 'token1Symbol'],
    ] as const) {
      if (p[key]) continue;
      const allowed = deps.tokens.findAllowed(MAINNET_CHAIN_ID, addr);
      if (allowed) p[key] = allowed.symbol;
      else if (addr !== NATIVE_ADDRESS) unknown.add(lower(addr));
      else p[key] = 'ETH';
    }
  }
  if (unknown.size === 0) return;
  try {
    const list = [...unknown].slice(0, 200) as Address[];
    const metas = await deps.reader(MAINNET_CHAIN_ID).erc20Metadata(list);
    const bySymbol = new Map<string, string | null>(
      list.map((a, i) => [a, metas[i]?.symbol ?? null])
    );
    for (const p of pools) {
      p.token0Symbol ??= bySymbol.get(lower(p.token0)) ?? null;
      p.token1Symbol ??= bySymbol.get(lower(p.token1)) ?? null;
    }
  } catch {
    /* symbols are cosmetic */
  }
}

async function usdPriceOf(deps: ToolDeps, token: Address): Promise<string | null> {
  if (token === NATIVE_ADDRESS) return tryReferencePriceUsd(deps, 'ETH');
  const ref = deps.tokens.referenceSymbolFor(MAINNET_CHAIN_ID, token);
  return ref ? tryReferencePriceUsd(deps, ref) : null;
}

/**
 * Official Uniswap source for v4 TVL: LP API /lp/pool_info by poolId returns live core reserves;
 * TVL = reserve0 × price0 + reserve1 × price1 (mainnet reference prices). Also fills fee,
 * tickSpacing and hooks. Pools whose tokens have no reference price keep tvlUsd = null.
 */
async function enrichFromLpApi(deps: ToolDeps, pools: MarketPoolInfo[]): Promise<void> {
  const prices = new Map<string, string | null>();
  for (let i = 0; i < pools.length; i += 20) {
    const chunk = pools.slice(i, i + 20);
    const res = await deps.lp.poolInfo({
      protocol: 'V4',
      chainId: MAINNET_CHAIN_ID as never,
      poolReferences: chunk.map((p) => ({
        protocol: 'V4',
        chainId: MAINNET_CHAIN_ID as never,
        referenceIdentifier: p.poolId,
      })),
    });
    const byId = new Map((res.pools ?? []).map((x) => [lower(x.poolReferenceIdentifier ?? ''), x]));
    for (const p of chunk) {
      const info = byId.get(p.poolId);
      if (!info) continue;
      if (info.fee !== undefined) p.fee = Number(info.fee);
      if (info.tickSpacing !== undefined) p.tickSpacing = Number(info.tickSpacing);
      if (info.hookAddress && /^0x[0-9a-fA-F]{40}$/.test(info.hookAddress))
        p.hooks = getAddress(info.hookAddress);
      if (info.token0Reserves === undefined || info.token1Reserves === undefined) continue;
      for (const t of [p.token0, p.token1]) {
        if (!prices.has(t)) prices.set(t, await usdPriceOf(deps, t));
      }
      const [p0, p1] = [prices.get(p.token0), prices.get(p.token1)];
      const dec0 = Number(info.tokenDecimalsA ?? 18);
      const dec1 = Number(info.tokenDecimalsB ?? 18);
      if (p0 && p1) {
        p.tvlUsd = new Decimal(info.token0Reserves)
          .div(new Decimal(10).pow(dec0))
          .mul(p0)
          .plus(new Decimal(info.token1Reserves).div(new Decimal(10).pow(dec1)).mul(p1))
          .toDecimalPlaces(2)
          .toFixed();
      }
    }
  }
}

/** Best-effort TVL from GeckoTerminal for pools still missing it. */
async function enrichTvlFromGecko(
  deps: ToolDeps,
  pools: MarketPoolInfo[],
  max = 60
): Promise<boolean> {
  const missing = pools.filter((p) => p.tvlUsd === null).slice(0, max);
  if (missing.length === 0 || !deps.gecko.enabled) return false;
  try {
    const found = await deps.cache.wrap(
      cacheKey(
        'gecko-pools',
        missing.map((p) => p.poolId)
      ),
      TTL.poolStats,
      () => deps.gecko.pools(missing.map((p) => p.poolId))
    );
    const byId = new Map(found.map((g) => [g.poolId, g]));
    for (const p of missing) {
      const g = byId.get(p.poolId);
      if (g?.reserveUsd) p.tvlUsd = new Decimal(g.reserveUsd).toDecimalPlaces(2).toFixed();
    }
    deps.health.markUp(SOURCES.gecko.name);
    return true;
  } catch (err) {
    deps.health.markDown(SOURCES.gecko.name, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** 7-day volume (sum of daily USD candles) and fees (volume × static fee) for the deepest pools. */
async function enrichVolumeFromGecko(deps: ToolDeps, pools: MarketPoolInfo[]): Promise<string[]> {
  const warnings: string[] = [];
  if (!deps.gecko.enabled || deps.health.isDown(SOURCES.gecko.name)) {
    return ['7-day volume unavailable (GeckoTerminal disabled or cooling down)'];
  }
  const top = [...pools]
    .filter((p) => p.tvlUsd !== null && new Decimal(p.tvlUsd).gt(0))
    .sort((a, b) => new Decimal(b.tvlUsd!).comparedTo(a.tvlUsd!))
    .slice(0, VOLUME_ENRICH_TOP);
  for (const p of top) {
    try {
      const candles = await deps.cache.wrap(`gecko-vol7d:${p.poolId}`, TTL.poolStats, () =>
        deps.gecko.ohlcv(p.poolId, 'day', 7, 'base')
      );
      const volume = candles.reduce((acc, c) => acc.plus(c[5] ?? 0), new Decimal(0));
      p.volume7dUsd = volume.toDecimalPlaces(2).toFixed();
      p.fees7dUsd =
        p.fee !== null && p.fee !== DYNAMIC_FEE_FLAG
          ? volume.mul(p.fee).div(1_000_000).toDecimalPlaces(2).toFixed()
          : null;
    } catch (err) {
      warnings.push(
        `No 7-day volume for ${p.poolId.slice(0, 10)}…: ${
          err instanceof Error ? err.message.slice(0, 120) : String(err)
        }`
      );
      if (err instanceof McpToolError && err.code === 'RATE_LIMITED') {
        deps.health.markDown(SOURCES.gecko.name, err.message);
        break;
      }
    }
  }
  if (pools.length > top.length)
    warnings.push(`7-day volume fetched for the ${top.length} deepest pool(s) only`);
  return warnings;
}

function geckoPairFilter(t0: Address, t1: Address) {
  const want = new Set([lower(t0), lower(t1)]);
  return (g: GeckoPool) =>
    g.dex === GECKO_V4_DEX &&
    /^0x[0-9a-f]{64}$/.test(g.poolId) &&
    want.has(g.baseToken) &&
    want.has(g.quoteToken) &&
    g.baseToken !== g.quoteToken;
}

async function geckoPairDiscovery(deps: ToolDeps, t0: Address, t1: Address): Promise<GeckoPool[]> {
  // Native ETH is not queryable as a token on GeckoTerminal; the pair is found via the other token.
  const queryTokens = [t0, t1].filter((t) => t !== NATIVE_ADDRESS);
  const lists = await Promise.all(queryTokens.map((t) => deps.gecko.tokenPools(t)));
  const matches = lists.flat().filter(geckoPairFilter(t0, t1));
  return [...new Map(matches.map((g) => [g.poolId, g])).values()];
}

// ---------------------------------------------------------------------------
// 1. Pools for a pair
// ---------------------------------------------------------------------------

export async function pairPools(
  deps: ToolDeps,
  a: Address,
  b: Address,
  options: { withVolume: boolean }
): Promise<MarketResult<MarketPoolInfo[]>> {
  const [t0, t1] =
    BigInt(a) < BigInt(b) ? [getAddress(a), getAddress(b)] : [getAddress(b), getAddress(a)];
  const key = cacheKey('market-pair-pools', { t0, t1, v: options.withVolume });
  return deps.cache.wrap(key, TTL.poolStats, async () => {
    const attempts: SourceAttempt<{
      data: MarketPoolInfo[];
      asOf: string | null;
      warnings?: string[];
    }>[] = [
      {
        ...SOURCES.subgraph,
        precheck: officialPrecheck(deps),
        run: async () => {
          const { pools, meta } = await deps.subgraph.poolsForPair(t0, t1, 20);
          const data = pools.map(fromSubgraph);
          if (options.withVolume && data.length) {
            const days = await deps.subgraph.poolDayData(
              data.map((p) => p.poolId),
              nowSec(deps) - 7 * 86_400
            );
            for (const p of data) {
              const mine = days.filter((d) => lower(d.pool.id) === p.poolId);
              p.volume7dUsd = mine
                .reduce((acc, d) => acc.plus(d.volumeUSD || '0'), new Decimal(0))
                .toDecimalPlaces(2)
                .toFixed();
              p.fees7dUsd = mine
                .reduce((acc, d) => acc.plus(d.feesUSD || '0'), new Decimal(0))
                .toDecimalPlaces(2)
                .toFixed();
            }
          }
          return { data, asOf: iso(meta.blockTimestamp) };
        },
      },
      {
        ...SOURCES.registry,
        run: async () => {
          const data = (await deps.registry.pairPools(t0, t1, 50)).map(fromRegistry);
          const warnings: string[] = [];
          try {
            await enrichFromLpApi(deps, data);
          } catch (err) {
            warnings.push(
              `LP API reserves unavailable (${
                err instanceof Error ? err.message.slice(0, 120) : String(err)
              }); TVL from GeckoTerminal`
            );
          }
          if (data.some((p) => p.tvlUsd === null)) await enrichTvlFromGecko(deps, data);
          if (options.withVolume) warnings.push(...(await enrichVolumeFromGecko(deps, data)));
          await fillSymbols(deps, data);
          return {
            data,
            asOf: new Date(deps.now()).toISOString(),
            warnings: [`TVL from ${SOURCES.lpApi.label}`, ...warnings],
          };
        },
      },
      {
        ...SOURCES.gecko,
        run: async () => {
          const found = await geckoPairDiscovery(deps, t0, t1);
          const data: MarketPoolInfo[] = found.map((g) => ({
            poolId: g.poolId,
            token0: t0,
            token1: t1,
            token0Symbol: null,
            token1Symbol: null,
            fee: null,
            tickSpacing: null,
            hooks: NATIVE_ADDRESS,
            createdAt: g.createdAt,
            createdAtBlock: null,
            tvlUsd: g.reserveUsd ? new Decimal(g.reserveUsd).toDecimalPlaces(2).toFixed() : null,
            volume7dUsd: null,
            fees7dUsd: null,
          }));
          // Fee, tickSpacing and hooks must come from Uniswap: never assume a pool is hookless.
          await enrichFromLpApi(deps, data);
          const known = data.filter((p) => p.fee !== null && p.tickSpacing !== null);
          if (options.withVolume) await enrichVolumeFromGecko(deps, known);
          await fillSymbols(deps, known);
          return {
            data: known,
            asOf: new Date(deps.now()).toISOString(),
            warnings: [
              'Pools discovered via GeckoTerminal; fee/tickSpacing/hooks from the Uniswap LP API',
            ],
          };
        },
      },
    ];
    return result(await failover(deps.health, 'pool listing', attempts));
  });
}

// ---------------------------------------------------------------------------
// 2. Pools using a hook (mainnet)
// ---------------------------------------------------------------------------

export async function hookPools(
  deps: ToolDeps,
  hook: Address
): Promise<MarketResult<MarketPoolInfo[]> & { completeHistory: boolean }> {
  const h = getAddress(hook);
  let completeHistory = true;
  const r = await deps.cache.wrap(cacheKey('market-hook-pools', { h }), TTL.hooks, async () =>
    result(
      await failover(deps.health, 'pools by hook', [
        {
          ...SOURCES.subgraph,
          precheck: officialPrecheck(deps),
          run: async () => {
            const { pools, meta } = await deps.subgraph.poolsByHook(h);
            return { data: pools.map(fromSubgraph), asOf: iso(meta.blockTimestamp) };
          },
        },
        {
          ...SOURCES.registry,
          run: async () => {
            const data = (await deps.registry.poolsByHook(h)).map(fromRegistry);
            await enrichTvlFromGecko(deps, data, 30);
            return { data, asOf: new Date(deps.now()).toISOString() };
          },
        },
        {
          ...SOURCES.logs,
          run: async () => {
            const scan = await scanInitializeLogs(deps, MAINNET_CHAIN_ID, {
              sinceDays: MAX_LOG_SCAN_DAYS,
            });
            const mine = scan.logs.filter((l) => lower(l.hooks) === lower(h));
            const reader = deps.reader(MAINNET_CHAIN_ID);
            const data = await Promise.all(
              mine.map(async (l) => ({
                poolId: lower(l.poolId),
                token0: l.currency0,
                token1: l.currency1,
                token0Symbol: null,
                token1Symbol: null,
                fee: l.fee,
                tickSpacing: l.tickSpacing,
                hooks: l.hooks,
                createdAt: iso(await reader.getBlockTimestamp(l.blockNumber).catch(() => null)),
                createdAtBlock: l.blockNumber.toString(),
                tvlUsd: null,
                volume7dUsd: null,
                fees7dUsd: null,
              }))
            );
            return {
              data,
              asOf: new Date(deps.now()).toISOString(),
              warnings: [`Only the last ${MAX_LOG_SCAN_DAYS} days of Initialize logs were scanned`],
            };
          },
        },
      ])
    )
  );
  if (r.source === SOURCES.logs.name) completeHistory = false;
  return { ...r, completeHistory };
}

// ---------------------------------------------------------------------------
// 3. New hook pools (mainnet)
// ---------------------------------------------------------------------------

export async function newHookPools(
  deps: ToolDeps,
  args: { sinceUnix: number; first: number; pair?: [Address, Address] }
): Promise<MarketResult<MarketPoolInfo[]> & { truncated: boolean }> {
  const pair = args.pair
    ? ((BigInt(args.pair[0]) < BigInt(args.pair[1]) ? args.pair : [args.pair[1], args.pair[0]]).map(
        (x) => getAddress(x)
      ) as [Address, Address])
    : undefined;
  let truncated = false;
  const r = await failover(deps.health, 'new hooks', [
    {
      ...SOURCES.subgraph,
      precheck: officialPrecheck(deps),
      run: async () => {
        const { pools, meta } = await deps.subgraph.newHookPools({
          sinceUnix: args.sinceUnix,
          first: args.first,
          ...(pair ? { pair } : {}),
        });
        truncated = pools.length >= args.first;
        return { data: pools.map(fromSubgraph), asOf: iso(meta.blockTimestamp) };
      },
    },
    {
      ...SOURCES.registry,
      run: async () => {
        const pools = await deps.registry.newHookPools({
          sinceUnix: args.sinceUnix,
          first: args.first,
          ...(pair ? { pair } : {}),
        });
        truncated = pools.length >= args.first;
        const data = pools.map(fromRegistry);
        await Promise.all([enrichTvlFromGecko(deps, data), fillSymbols(deps, data)]);
        return {
          data,
          asOf: new Date(deps.now()).toISOString(),
          warnings: ['TVL from GeckoTerminal (best effort)'],
        };
      },
    },
    {
      ...SOURCES.logs,
      run: async () => {
        const wanted = Math.ceil((nowSec(deps) - args.sinceUnix) / 86_400);
        const days = Math.min(MAX_LOG_SCAN_DAYS, Math.max(1, wanted));
        const scan = await scanInitializeLogs(deps, MAINNET_CHAIN_ID, {
          sinceDays: days,
          ...(pair ? { filter: { currency0: pair[0], currency1: pair[1] } } : {}),
        });
        const hooked = scan.logs.filter((l) => !isZeroHook(l.hooks)).reverse();
        truncated = scan.truncated || hooked.length > args.first;
        const reader = deps.reader(MAINNET_CHAIN_ID);
        const data = await Promise.all(
          hooked.slice(0, args.first).map(async (l) => ({
            poolId: lower(l.poolId),
            token0: l.currency0,
            token1: l.currency1,
            token0Symbol: null,
            token1Symbol: null,
            fee: l.fee,
            tickSpacing: l.tickSpacing,
            hooks: l.hooks,
            createdAt: iso(await reader.getBlockTimestamp(l.blockNumber).catch(() => null)),
            createdAtBlock: l.blockNumber.toString(),
            tvlUsd: null,
            volume7dUsd: null,
            fees7dUsd: null,
          }))
        );
        await fillSymbols(deps, data);
        const warnings =
          wanted > days
            ? [`Initialize logs scanned for the last ${days} days only (asked ${wanted})`]
            : [];
        return { data, asOf: new Date(deps.now()).toISOString(), warnings };
      },
    },
  ]);
  return { ...result(r), truncated };
}

// ---------------------------------------------------------------------------
// 4. USD price series (mainnet)
// ---------------------------------------------------------------------------

export interface PriceSeries {
  points: { ts: number; price: string }[];
  sourceKind: 'pool' | 'token';
  sourceId: string;
  description: string;
  lagSeconds: number | null;
  hasIndexingErrors: boolean | null;
}

function pickDeepest(pools: MarketPoolInfo[]): MarketPoolInfo | undefined {
  const withTvl = pools.filter((p) => p.tvlUsd !== null && new Decimal(p.tvlUsd).gt(0));
  const byTvl = (x: MarketPoolInfo, y: MarketPoolInfo) =>
    new Decimal(y.tvlUsd!).comparedTo(x.tvlUsd!);
  // Prefer hookless pools: a hook can move the reported price.
  return withTvl.filter((p) => isZeroHook(p.hooks)).sort(byTvl)[0] ?? withTvl.sort(byTvl)[0];
}

function periodStarts(sinceUnix: number, untilUnix: number, interval: 'hour' | 'day'): number[] {
  const step = interval === 'hour' ? 3_600 : 86_400;
  const start = sinceUnix - (sinceUnix % step);
  const out: number[] = [];
  for (let t = start; t <= untilUnix; t += step) out.push(t);
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}

export async function priceSeries(
  deps: ToolDeps,
  args: { symbol: string; interval: 'hour' | 'day'; sinceUnix: number }
): Promise<MarketResult<PriceSeries>> {
  const symbol = args.symbol.toUpperCase() === 'WETH' ? 'ETH' : args.symbol.toUpperCase();
  const usdc = requireChainAddress(MAINNET_CHAIN_ID, 'usdc');
  const token =
    symbol === 'ETH'
      ? NATIVE_ADDRESS
      : (deps.tokens.mainnetToken(symbol)?.address as Address | undefined);
  if (!token) {
    throw new McpToolError(
      'UNKNOWN_TOKEN',
      `No mainnet reference token for "${symbol}" (allowlist it in TOKEN_ALLOWLIST_JSON for chain 1)`,
      {
        retryable: false,
      }
    );
  }
  const tokenDecimals = symbol === 'ETH' ? 18 : deps.tokens.mainnetToken(symbol)?.decimals ?? 18;
  const isUsdc = lower(token) === lower(usdc);
  const now = nowSec(deps);
  const targets = periodStarts(args.sinceUnix, now, args.interval);

  const key = cacheKey('market-price-series', { symbol, i: args.interval, since: args.sinceUnix });
  return deps.cache.wrap(key, TTL.poolStats, async () =>
    result(
      await failover<{ data: PriceSeries; asOf: string | null; warnings?: string[] }>(
        deps.health,
        'price history',
        [
          {
            ...SOURCES.subgraph,
            precheck: officialPrecheck(deps),
            run: async () => {
              if (symbol === 'ETH') {
                const { pools } = await deps.subgraph.poolsForPair(NATIVE_ADDRESS, usdc, 5);
                const pool = pools[0];
                if (!pool)
                  throw new McpToolError('POOL_NOT_FOUND', 'No ETH/USDC v4 pool in the subgraph', {
                    retryable: false,
                  });
                const { points, meta } = await deps.subgraph.poolPrices(
                  pool.id,
                  args.interval,
                  args.sinceUnix
                );
                const ethIsToken0 = lower(pool.token0.id) === NATIVE_ADDRESS;
                return {
                  data: {
                    // token1Price = token1 per token0; ETH is currency0 → USDC per ETH.
                    points: points.map((p) => ({
                      ts: p.ts,
                      price: (ethIsToken0 ? p.token1Price : p.token0Price) ?? '0',
                    })),
                    sourceKind: 'pool',
                    sourceId: pool.id,
                    description: `Uniswap v4 ETH/USDC pool (fee ${pool.feeTier}, TVL $${Math.round(
                      Number(pool.totalValueLockedUSD)
                    ).toLocaleString('en-US')})`,
                    lagSeconds:
                      meta.blockTimestamp !== null ? Math.max(0, now - meta.blockTimestamp) : null,
                    hasIndexingErrors: meta.hasIndexingErrors,
                  },
                  asOf: iso(meta.blockTimestamp),
                };
              }
              const { points, meta } = await deps.subgraph.tokenPrices(
                token,
                args.interval,
                args.sinceUnix
              );
              return {
                data: {
                  points: points.map((p) => ({ ts: p.ts, price: p.priceUSD ?? '0' })),
                  sourceKind: 'token',
                  sourceId: lower(token),
                  description: `Uniswap v4 subgraph ${symbol} ${args.interval} data`,
                  lagSeconds:
                    meta.blockTimestamp !== null ? Math.max(0, now - meta.blockTimestamp) : null,
                  hasIndexingErrors: meta.hasIndexingErrors,
                },
                asOf: iso(meta.blockTimestamp),
              };
            },
          },
          {
            ...SOURCES.stateview,
            precheck: async () =>
              isUsdc
                ? 'USDC is the quote currency; no on-chain USD pair to read'
                : targets.length > MAX_ONCHAIN_POINTS
                ? `too many points for on-chain reads (${targets.length} > ${MAX_ONCHAIN_POINTS})`
                : null,
            run: async () => {
              const listing = await pairPools(deps, token, usdc, { withVolume: false });
              const pool = pickDeepest(listing.data);
              if (!pool)
                throw new McpToolError(
                  'POOL_NOT_FOUND',
                  `No v4 ${symbol}/USDC pool with known TVL`,
                  { retryable: false }
                );
              const reader = deps.reader(MAINNET_CHAIN_ID);
              const stateView = getChain(MAINNET_CHAIN_ID).stateView;
              const head = await reader.getBlockNumber();
              const headTs = await reader.getBlockTimestamp(head);
              // Calibrate seconds-per-block once from the earliest target, then interpolate.
              const first = targets[0]!;
              const guess = head - BigInt(Math.max(0, Math.floor((headTs - first) / 12)));
              const guessTs = await reader.getBlockTimestamp(guess);
              const spb =
                guessTs < headTs && head > guess ? (headTs - guessTs) / Number(head - guess) : 12;
              const blockAt = (ts: number) => {
                if (ts >= headTs) return head;
                const back = BigInt(Math.max(0, Math.round((headTs - ts) / spb)));
                return back > head ? 0n : head - back;
              };
              const tokenIsC0 = lower(pool.token0) === lower(token);
              const points = await mapLimit(targets, 8, async (ts) => {
                const slot0 = await reader.getSlot0(stateView, pool.poolId as Hex, blockAt(ts));
                if (slot0.sqrtPriceX96 === 0n) return null;
                const p = tokenIsC0
                  ? priceFromSqrt(slot0.sqrtPriceX96, tokenDecimals, 6)
                  : new Decimal(1).div(priceFromSqrt(slot0.sqrtPriceX96, 6, tokenDecimals));
                return { ts, price: p.toDecimalPlaces(6).toFixed() };
              });
              const valid = points.filter((p): p is { ts: number; price: string } => p !== null);
              if (valid.length === 0)
                throw new McpToolError(
                  'POOL_NOT_FOUND',
                  'Pool had no price at the requested blocks',
                  { retryable: false }
                );
              return {
                data: {
                  points: valid,
                  sourceKind: 'pool',
                  sourceId: pool.poolId,
                  description: `Uniswap v4 ${symbol}/USDC pool (fee ${
                    pool.fee ?? '?'
                  }, TVL $${Math.round(Number(pool.tvlUsd)).toLocaleString(
                    'en-US'
                  )}) read on-chain via StateView at historical blocks`,
                  lagSeconds: Math.max(0, now - headTs),
                  hasIndexingErrors: null,
                },
                asOf: iso(headTs),
                warnings: [
                  `Pool chosen from ${listing.sourceLabel}`,
                  'Spot price at each period start (no intra-period high/low)',
                ],
              };
            },
          },
          {
            ...SOURCES.gecko,
            run: async () => {
              // Native ETH is listed under USDC's pools (GeckoTerminal's per-token endpoint is for ERC-20s).
              const queryToken = isUsdc || token === NATIVE_ADDRESS ? usdc : token;
              const found = (await deps.gecko.tokenPools(queryToken)).filter(
                (g) =>
                  g.dex === GECKO_V4_DEX &&
                  (isUsdc
                    ? [g.baseToken, g.quoteToken].includes(lower(usdc))
                    : [g.baseToken, g.quoteToken].includes(lower(usdc)) &&
                      [g.baseToken, g.quoteToken].includes(lower(token)))
              );
              const pool = found
                .filter((g) => g.reserveUsd !== null)
                .sort((x, y) => new Decimal(y.reserveUsd!).comparedTo(x.reserveUsd!))[0];
              if (!pool)
                throw new McpToolError(
                  'POOL_NOT_FOUND',
                  `GeckoTerminal has no Uniswap v4 pool for ${symbol}`,
                  { retryable: false }
                );
              const side = pool.baseToken === lower(token) ? 'base' : 'quote';
              const candles = await deps.gecko.ohlcv(
                pool.poolId,
                args.interval,
                targets.length + 1,
                side
              );
              const points = candles
                .filter((c) => c[0] >= targets[0]!)
                .map((c) => ({ ts: c[0], price: new Decimal(c[4]).toDecimalPlaces(6).toFixed() }));
              const last = candles.at(-1)?.[0] ?? null;
              return {
                data: {
                  points,
                  sourceKind: 'pool',
                  sourceId: pool.poolId,
                  description: `GeckoTerminal OHLCV (close) for Uniswap v4 pool ${
                    pool.name
                  } (TVL $${Math.round(Number(pool.reserveUsd)).toLocaleString('en-US')})`,
                  lagSeconds: last !== null ? Math.max(0, now - last) : null,
                  hasIndexingErrors: null,
                },
                asOf: iso(last),
                warnings: [
                  'Third-party data (GeckoTerminal) used because Uniswap sources were unavailable',
                ],
              };
            },
          },
        ]
      )
    )
  );
}
