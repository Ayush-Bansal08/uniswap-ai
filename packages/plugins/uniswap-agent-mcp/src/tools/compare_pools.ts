/**
 * compare_pools — which v4 pool to use for a pair, from two labelled sources:
 *   execution chain: LP API `/lp/pool_info` (which pools exist) + StateView (live liquidity/tick)
 *   market reference (mainnet): TVL, 7-day volume/fees, fee APR = fees7d·52/TVL·100, from the
 *   failover chain in src/market/data.ts (official subgraph → pool registry + LP API reserves +
 *   GeckoTerminal volume → GeckoTerminal)
 * Ranking is deterministic: usable on the execution chain first, then APR × hook-band factor,
 * then TVL, then fee tier, then poolId.
 */
import { getAddress, type Address, type Hex } from 'viem';
import type { z } from 'zod';
import { Decimal } from '../amounts.js';
import { DYNAMIC_FEE_FLAG, getChain, MAINNET_CHAIN_ID, ZERO_ADDRESS } from '../chains.js';
import type { PoolInformation } from '../clients/lpApi.js';
import { requireReadableChain, type ToolDeps } from '../context.js';
import { invalidInput, McpToolError } from '../errors.js';
import { isZeroHook } from '../hooks/permissions.js';
import {
  ComparePoolsInputSchema,
  ComparePoolsOutputSchema,
  type HookBand,
  type TokenInfo,
} from '../schemas.js';
import { scoreHookCached } from '../services/hookFacts.js';
import { pairPools } from '../market/data.js';
import { sortTokens } from '../v4/math.js';
import { defineTool } from './define.js';

type Out = z.infer<typeof ComparePoolsOutputSchema>;
type ExecPool = Out['execution']['pools'][number];
type MarketPool = Out['market']['pools'][number];
type Ranked = Out['ranked'][number];

/** Standard v4 fee/tickSpacing pairs probed if pool_info cannot list pools without a fee. */
export const STANDARD_TIERS: ReadonlyArray<readonly [number, number]> = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

export const BAND_FACTOR: Record<HookBand | 'NONE' | 'UNSCORED', number> = {
  NONE: 1,
  SAFE: 1,
  CAUTION: 0.5,
  DANGER: 0,
  UNSCORED: 0.5,
};

const MAX_HOOKS_SCORED = 6;

async function executionPools(
  deps: ToolDeps,
  chainId: number,
  t0: TokenInfo,
  t1: TokenInfo
): Promise<ExecPool[]> {
  const chain = getChain(chainId);
  let infos: PoolInformation[] = [];
  try {
    const res = await deps.lp.poolInfo({
      protocol: 'V4',
      chainId: chainId as never,
      poolParameters: { tokenAddressA: t0.address, tokenAddressB: t1.address },
      pageSize: 20,
    });
    infos = res.pools ?? [];
  } catch (err) {
    if (!(err instanceof McpToolError) || err.code !== 'INVALID_INPUT') throw err;
    // The API may require fee + tickSpacing: probe the standard hookless tiers instead.
    const results = await Promise.all(
      STANDARD_TIERS.map(([fee, tickSpacing]) =>
        deps.lp
          .poolInfo({
            protocol: 'V4',
            chainId: chainId as never,
            poolParameters: {
              tokenAddressA: t0.address,
              tokenAddressB: t1.address,
              fee,
              tickSpacing,
            },
          })
          .then((r) => r.pools ?? [])
          .catch(() => [] as PoolInformation[])
      )
    );
    infos = results.flat();
  }
  const pair = new Set([t0.address.toLowerCase(), t1.address.toLowerCase()]);
  const relevant = infos.filter(
    (p) =>
      p.poolReferenceIdentifier &&
      /^0x[0-9a-fA-F]{64}$/.test(p.poolReferenceIdentifier) &&
      (!p.tokenAddressA || pair.has(p.tokenAddressA.toLowerCase())) &&
      (!p.tokenAddressB || pair.has(p.tokenAddressB.toLowerCase()))
  );
  const unique = [
    ...new Map(relevant.map((p) => [p.poolReferenceIdentifier!.toLowerCase(), p])).values(),
  ];
  const reader = deps.reader(chainId);
  return Promise.all(
    unique.map(async (p) => {
      const poolId = p.poolReferenceIdentifier!.toLowerCase() as Hex;
      const hookAddress =
        p.hookAddress && /^0x[0-9a-fA-F]{40}$/.test(p.hookAddress)
          ? getAddress(p.hookAddress)
          : ZERO_ADDRESS;
      const fee = Number(p.fee ?? 0);
      let live: { sqrtPriceX96: bigint; tick: number; liquidity: bigint } | null = null;
      try {
        const [slot0, liquidity] = await Promise.all([
          reader.getSlot0(chain.stateView, poolId),
          reader.getLiquidity(chain.stateView, poolId),
        ]);
        live = { sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, liquidity };
      } catch {
        live = null;
      }
      return {
        poolId,
        fee,
        tickSpacing: Number(p.tickSpacing ?? 0),
        hookAddress,
        isDynamicFee: fee === DYNAMIC_FEE_FLAG,
        liquidity: live ? live.liquidity.toString() : p.poolLiquidity ?? null,
        currentTick: live ? live.tick : p.currentTick !== undefined ? Number(p.currentTick) : null,
        sqrtPriceX96: live ? live.sqrtPriceX96.toString() : p.sqrtRatioX96 ?? null,
        initialized: live ? live.sqrtPriceX96 > 0n : !!p.sqrtRatioX96 && p.sqrtRatioX96 !== '0',
      } satisfies ExecPool;
    })
  );
}

async function marketPools(
  deps: ToolDeps,
  chainId: number,
  a: TokenInfo,
  b: TokenInfo
): Promise<{ pools: MarketPool[]; asOf: string | null; source: string; warnings: string[] }> {
  const refA = deps.tokens.referenceSymbolFor(chainId, a.address);
  const refB = deps.tokens.referenceSymbolFor(chainId, b.address);
  const mA = refA ? deps.tokens.mainnetToken(refA) : undefined;
  const mB = refB ? deps.tokens.mainnetToken(refB) : undefined;
  if (!mA || !mB) {
    throw new McpToolError(
      'UNKNOWN_TOKEN',
      'No mainnet reference tokens for this pair (allowlist them for chain 1)',
      { retryable: false }
    );
  }
  // Failover: official subgraph → pool registry + LP API reserves + GeckoTerminal volume → GeckoTerminal.
  const listing = await pairPools(deps, mA.address as Address, mB.address as Address, {
    withVolume: true,
  });
  const pools = listing.data
    .filter((p) => p.fee !== null && p.tickSpacing !== null)
    .map((p) => {
      const tvl = p.tvlUsd !== null ? new Decimal(p.tvlUsd) : null;
      const apr =
        tvl && tvl.gt(0) && p.fees7dUsd !== null
          ? new Decimal(p.fees7dUsd).mul(52).div(tvl).mul(100).toDecimalPlaces(2).toFixed()
          : null;
      return {
        poolId: p.poolId as Hex,
        fee: p.fee!,
        tickSpacing: p.tickSpacing!,
        hookAddress: p.hooks,
        isDynamicFee: p.fee === DYNAMIC_FEE_FLAG,
        tvlUsd: p.tvlUsd,
        volume7dUsd: p.volume7dUsd,
        fees7dUsd: p.fees7dUsd,
        feeAprPct: apr,
        createdAt: p.createdAt,
      } satisfies MarketPool;
    })
    .sort((x, y) => new Decimal(y.tvlUsd ?? -1).comparedTo(x.tvlUsd ?? -1))
    .slice(0, 20);
  return { pools, asOf: listing.asOf, source: listing.sourceLabel, warnings: listing.warnings };
}

export const comparePoolsTool = defineTool({
  name: 'compare_pools',
  title: 'Compare v4 pools for a pair',
  description:
    'Compare Uniswap v4 pools for a token pair from two labelled sources: (1) the execution chain — pools that exist and can be used, from the LP API /lp/pool_info plus live StateView liquidity/tick; (2) the market reference on Ethereum mainnet — TVL, 7-day volume and fees, fee APR, from the official v4 subgraph with automatic failover to the v4 pool registry + Uniswap LP API reserves + GeckoTerminal volume. Hook pools are scored (score_hook). Returns a deterministic ranking and a recommended pool with reasons (usable first, then APR × hook-band factor, then TVL). Read-only.',
  kind: 'read',
  input: ComparePoolsInputSchema,
  output: ComparePoolsOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    const [a, b] = await Promise.all([
      deps.tokens.resolve(args.chainId, args.tokenA),
      deps.tokens.resolve(args.chainId, args.tokenB),
    ]);
    if (a.address === b.address) throw invalidInput('tokenA and tokenB must differ');
    const [t0, t1] = sortTokens(a, b);

    const [execResult, marketResult] = await Promise.allSettled([
      executionPools(deps, args.chainId, t0, t1),
      marketPools(deps, args.chainId, t0, t1),
    ]);
    const exec = execResult.status === 'fulfilled' ? execResult.value : [];
    const market =
      marketResult.status === 'fulfilled'
        ? marketResult.value
        : { pools: [], asOf: null, source: 'unavailable', warnings: [] };
    const errorText = (r: PromiseSettledResult<unknown>) =>
      r.status === 'rejected'
        ? r.reason instanceof Error
          ? r.reason.message
          : String(r.reason)
        : null;

    // Score hooks (execution chain hooks on that chain, market hooks on mainnet).
    const hookTargets = [
      ...exec
        .filter((p) => !isZeroHook(p.hookAddress))
        .map((p) => ({ chainId: args.chainId, hook: p.hookAddress })),
      ...market.pools
        .filter((p) => !isZeroHook(p.hookAddress))
        .map((p) => ({ chainId: MAINNET_CHAIN_ID, hook: p.hookAddress })),
    ];
    const distinct = [
      ...new Map(hookTargets.map((h) => [`${h.chainId}:${h.hook}`, h])).values(),
    ].slice(0, MAX_HOOKS_SCORED);
    const scores = new Map<string, { band: HookBand; score: number }>();
    await Promise.all(
      distinct.map(async (h) => {
        try {
          const s = await scoreHookCached(deps, h.chainId, h.hook as Address);
          scores.set(`${h.chainId}:${h.hook}`, { band: s.band, score: s.score });
        } catch {
          /* unscored */
        }
      })
    );
    const hookInfo = (chainId: number, hook: string) => {
      if (isZeroHook(hook))
        return { band: null, score: null, factor: BAND_FACTOR.NONE, label: 'no hook' };
      const s = scores.get(`${chainId}:${hook}`);
      return s
        ? {
            band: s.band,
            score: s.score,
            factor: BAND_FACTOR[s.band],
            label: `hook ${s.band} (${s.score}/100)`,
          }
        : { band: null, score: null, factor: BAND_FACTOR.UNSCORED, label: 'hook not scored' };
    };

    const usedMarket = new Set<string>();
    const candidates: Omit<Ranked, 'rank'>[] = exec.map((p) => {
      const usable = p.initialized && p.liquidity !== null && BigInt(p.liquidity) > 0n;
      const ref = isZeroHook(p.hookAddress)
        ? market.pools.find(
            (m) => m.fee === p.fee && m.tickSpacing === p.tickSpacing && isZeroHook(m.hookAddress)
          )
        : undefined;
      if (ref) usedMarket.add(ref.poolId);
      const h = hookInfo(args.chainId, p.hookAddress);
      const adjusted =
        ref && ref.feeAprPct !== null
          ? new Decimal(ref.feeAprPct).mul(h.factor).toDecimalPlaces(2).toFixed()
          : null;
      const reasons = [
        usable
          ? 'Initialized with liquidity on the execution chain'
          : 'Not usable on the execution chain (uninitialized or no liquidity)',
        `Fee ${(p.fee / 10_000).toFixed(2)}% / tickSpacing ${p.tickSpacing}`,
        h.label,
        ref
          ? `Mainnet reference: APR ${ref.feeAprPct ?? 'n/a'}%, TVL ${ref.tvlUsd ?? 'n/a'}`
          : 'No matching mainnet reference pool',
      ];
      if (h.band === 'DANGER') reasons.push('Excluded from recommendation: DANGER hook');
      return {
        poolId: p.poolId,
        source: 'execution' as const,
        usableOnExecutionChain: usable,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hookAddress: p.hookAddress,
        hookBand: h.band,
        hookScore: h.score,
        referenceFeeAprPct: ref?.feeAprPct ?? null,
        adjustedAprPct: adjusted,
        referenceTvlUsd: ref?.tvlUsd ?? null,
        reasons,
      };
    });
    for (const m of market.pools) {
      if (usedMarket.has(m.poolId)) continue;
      const h = hookInfo(MAINNET_CHAIN_ID, m.hookAddress);
      candidates.push({
        poolId: m.poolId,
        source: 'market',
        usableOnExecutionChain: false,
        fee: m.fee,
        tickSpacing: m.tickSpacing,
        hookAddress: m.hookAddress,
        hookBand: h.band,
        hookScore: h.score,
        referenceFeeAprPct: m.feeAprPct,
        adjustedAprPct:
          m.feeAprPct !== null
            ? new Decimal(m.feeAprPct).mul(h.factor).toDecimalPlaces(2).toFixed()
            : null,
        referenceTvlUsd: m.tvlUsd,
        reasons: [
          'Mainnet market reference only (no equivalent pool on the execution chain)',
          `APR ${m.feeAprPct ?? 'n/a'}%, TVL ${m.tvlUsd ?? 'n/a'}, 7d volume ${
            m.volume7dUsd ?? 'n/a'
          }`,
          h.label,
        ],
      });
    }

    const dec = (v: string | null) => (v === null ? new Decimal(-1) : new Decimal(v));
    candidates.sort((x, y) => {
      if (x.usableOnExecutionChain !== y.usableOnExecutionChain)
        return x.usableOnExecutionChain ? -1 : 1;
      const apr = dec(y.adjustedAprPct).comparedTo(dec(x.adjustedAprPct));
      if (apr !== 0) return apr;
      const tvl = dec(y.referenceTvlUsd).comparedTo(dec(x.referenceTvlUsd));
      if (tvl !== 0) return tvl;
      if (x.fee !== y.fee) return x.fee - y.fee;
      return x.poolId < y.poolId ? -1 : x.poolId > y.poolId ? 1 : 0;
    });
    const ranked: Ranked[] = candidates.map((c, i) => ({ ...c, rank: i + 1 }));
    const recommended =
      ranked.find((r) => r.usableOnExecutionChain && r.hookBand !== 'DANGER') ?? null;
    const reasons = recommended
      ? [
          `Recommended pool ${recommended.poolId} (rank ${recommended.rank})`,
          'Ranking: usable on the execution chain → APR × hook-band factor (SAFE 1, CAUTION 0.5, DANGER 0, unscored 0.5) → reference TVL → lower fee',
          ...recommended.reasons,
        ]
      : ['No usable, non-DANGER pool for this pair on the execution chain'];

    return {
      chainId: args.chainId,
      tokenA: a,
      tokenB: b,
      execution: {
        chainId: args.chainId,
        label: `Execution chain (${getChain(args.chainId).name})`,
        source: 'Uniswap LP API /lp/pool_info + v4 StateView',
        pools: exec,
        error: errorText(execResult),
      },
      market: {
        chainId: 1 as const,
        label: 'Market reference (Ethereum mainnet)',
        source: market.source,
        pools: market.pools,
        asOf: market.asOf,
        error: errorText(marketResult),
        warnings: market.warnings,
      },
      ranked,
      recommended,
      reasons,
    };
  },
  summarize(o) {
    const rec = o.recommended
      ? `recommended ${o.recommended.poolId.slice(0, 10)}… fee ${o.recommended.fee} (${
          o.recommended.hookBand ?? 'no hook'
        }, ref APR ${o.recommended.referenceFeeAprPct ?? 'n/a'}%)`
      : 'no usable pool';
    return `${o.tokenA.symbol}/${o.tokenB.symbol}: ${o.execution.pools.length} execution pool(s), ${
      o.market.pools.length
    } mainnet reference pool(s); ${rec}.${
      o.execution.error ? ` Execution source error: ${o.execution.error}.` : ''
    }${o.market.error ? ` Market source error: ${o.market.error}.` : ''}`;
  },
});
