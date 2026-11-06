import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { sqrtPriceAtTick } from '../src/v4/math.js';
import {
  HOOK_ADDR,
  HOOK_POOL,
  mainnetEthPriceQuote,
  subgraphResponse,
  V4_ETH_USDC_POOL,
} from './fixtures.js';
import {
  encodePositionInfo,
  ETH,
  fail,
  GRAPH,
  harness,
  LP,
  MAINNET_USDC,
  ok,
  OTHER,
  SEPOLIA,
  SEPOLIA_USDC,
  SWAPPER,
  TRADE,
} from './helpers.js';

const TICK = -196300;
const POOL_KEY = {
  currency0: ETH,
  currency1: SEPOLIA_USDC,
  fee: 3000,
  tickSpacing: 60,
  hooks: ETH,
} as const;
const GRAPH_URL = `${GRAPH}/test-graph-key/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`;

function seedPool(
  h: ReturnType<typeof harness>,
  poolId: string = V4_ETH_USDC_POOL,
  liquidity = 5_000_000_000_000_000n
) {
  h.exec.slot0.set(poolId, {
    sqrtPriceX96: sqrtPriceAtTick(TICK),
    tick: TICK,
    protocolFee: 0,
    lpFee: 3000,
  });
  h.exec.liquidity.set(poolId, liquidity);
}

describe('get_lp_positions', () => {
  it('reads PositionManager + StateView and computes amounts, range, fees and USD value', async () => {
    const h = harness();
    seedPool(h);
    const L = 2_000_000_000_000n;
    h.exec.positions.set('42', {
      poolKey: POOL_KEY,
      info: encodePositionInfo(V4_ETH_USDC_POOL as Hex, -196860, -195780),
      liquidity: L,
      owner: SWAPPER,
    });
    h.exec.feeState = {
      liquidity: L,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 10n << 128n,
      feeGrowthInside0X128: 3n << 128n,
      feeGrowthInside1X128: 11n << 128n,
    };
    h.http.on('POST', `${TRADE}/quote`, { body: mainnetEthPriceQuote('3000000000') });

    const out = await ok(h, 'get_lp_positions', {
      chainId: SEPOLIA,
      owner: SWAPPER,
      tokenIds: ['42', '99'],
    });
    expect(out.notFound).toEqual(['99']);
    const p = out.positions[0];
    expect(p).toMatchObject({
      tokenId: '42',
      ownerMatches: true,
      poolId: V4_ETH_USDC_POOL,
      hookAddress: null,
      tickLower: -196860,
      tickUpper: -195780,
      currentTick: TICK,
      inRange: true,
      liquidity: L.toString(),
    });
    expect(BigInt(p.amount0.raw)).toBeGreaterThan(0n);
    expect(BigInt(p.amount1.raw)).toBeGreaterThan(0n);
    expect(p.uncollectedFees0.raw).toBe((3n * L).toString());
    expect(p.uncollectedFees1.raw).toBe(L.toString());
    expect(Number(p.priceCurrent)).toBeGreaterThan(2900);
    expect(Number(p.priceCurrent)).toBeLessThan(3100);
    expect(Number(p.priceLower)).toBeLessThan(Number(p.priceCurrent));
    expect(Number(p.valueUsd)).toBeGreaterThan(0);
  });

  it('flags positions held by another address', async () => {
    const h = harness();
    seedPool(h);
    h.exec.positions.set('7', {
      poolKey: POOL_KEY,
      info: encodePositionInfo(V4_ETH_USDC_POOL as Hex, -196860, -195780),
      liquidity: 1n,
      owner: OTHER,
    });
    h.http.on('POST', `${TRADE}/quote`, { body: mainnetEthPriceQuote() });
    const out = await ok(h, 'get_lp_positions', {
      chainId: SEPOLIA,
      owner: SWAPPER,
      tokenIds: ['7'],
    });
    expect(out.positions[0].ownerMatches).toBe(false);
    expect(out.positions[0].owner).toBe(OTHER);
  });
});

describe('compare_pools', () => {
  const marketHookless = {
    id: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    feeTier: '3000',
    tickSpacing: '60',
    hooks: '0x0000000000000000000000000000000000000000',
    totalValueLockedUSD: '10000000',
    createdAtTimestamp: '1733000000',
    createdAtBlockNumber: '21000000',
    token0: { id: ETH, symbol: 'ETH', decimals: '18' },
    token1: { id: MAINNET_USDC.toLowerCase(), symbol: 'USDC', decimals: '6' },
  };
  const marketDeep = {
    ...marketHookless,
    id: '0xaaaa000000000000000000000000000000000000000000000000000000000002',
    feeTier: '500',
    tickSpacing: '10',
    totalValueLockedUSD: '150000000',
  };

  function seed(
    h: ReturnType<typeof harness>,
    opts: { subgraphDown?: boolean; poolInfoNeedsFee?: boolean } = {}
  ) {
    seedPool(h, V4_ETH_USDC_POOL);
    seedPool(h, HOOK_POOL, 1_000_000n);
    h.exec.code.set(HOOK_ADDR, '0x6080604052');
    h.exec.code.set('0xe03a1074c86cfedd5c142c4f04f1a1536e203543', '0x6080'); // PoolManager
    const pools = [
      {
        poolReferenceIdentifier: V4_ETH_USDC_POOL,
        poolProtocol: 'V4',
        tokenAddressA: ETH,
        tokenAddressB: SEPOLIA_USDC,
        fee: 3000,
        tickSpacing: 60,
        hookAddress: ETH,
        chainId: SEPOLIA,
      },
      {
        poolReferenceIdentifier: HOOK_POOL,
        poolProtocol: 'V4',
        tokenAddressA: ETH,
        tokenAddressB: SEPOLIA_USDC,
        fee: 3000,
        tickSpacing: 60,
        hookAddress: HOOK_ADDR,
        chainId: SEPOLIA,
      },
    ];
    h.http.on('POST', `${LP}/lp/pool_info`, (req) => {
      const body = req.body as { poolParameters?: { fee?: number } };
      if (opts.poolInfoNeedsFee && body.poolParameters?.fee === undefined) {
        return {
          status: 400,
          body: { error: 'RequestValidationError', message: 'fee is required' },
        };
      }
      if (opts.poolInfoNeedsFee)
        return {
          body: { requestId: 'p', pools: body.poolParameters?.fee === 3000 ? [pools[0]] : [] },
        };
      return { body: { requestId: 'p', pools } };
    });
    h.http.on('POST', GRAPH_URL, (req) => {
      if (opts.subgraphDown) return { body: { errors: [{ message: 'indexing_error' }] } };
      const q = (req.body as { query: string }).query;
      if (q.includes('poolDayDatas')) {
        return {
          body: subgraphResponse({
            poolDayDatas: Array.from({ length: 7 }, (_, i) => ({
              date: 1762000000 + i * 86400,
              pool: { id: marketHookless.id },
              volumeUSD: '333333',
              feesUSD: '1000',
              tvlUSD: '10000000',
            })),
          }),
        };
      }
      return { body: subgraphResponse({ pools: [marketDeep, marketHookless] }) };
    });
  }

  it('ranks usable execution pools first, uses mainnet APR and scores hooks', async () => {
    const h = harness();
    seed(h);
    const out = await ok(h, 'compare_pools', { chainId: SEPOLIA, tokenA: 'USDC', tokenB: 'ETH' });

    expect(out.execution.pools).toHaveLength(2);
    expect(
      out.market.pools.find((p: { poolId: string }) => p.poolId === marketHookless.id)
    ).toMatchObject({
      fees7dUsd: '7000',
      feeAprPct: '3.64', // 7000 × 52 / 10M × 100
    });
    expect(out.recommended).toMatchObject({
      poolId: V4_ETH_USDC_POOL,
      usableOnExecutionChain: true,
      referenceFeeAprPct: '3.64',
      adjustedAprPct: '3.64',
    });
    const hooked = out.ranked.find((r: { poolId: string }) => r.poolId === HOOK_POOL);
    expect(hooked).toMatchObject({ usableOnExecutionChain: true, hookBand: 'SAFE', hookScore: 80 });
    expect(out.ranked.at(-1)).toMatchObject({ source: 'market', usableOnExecutionChain: false });
    expect(out.ranked.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);
    expect(out.reasons[0]).toContain(V4_ETH_USDC_POOL);
  });

  it('still ranks execution pools when the subgraph is down (labelled error)', async () => {
    const h = harness();
    seed(h, { subgraphDown: true });
    const out = await ok(h, 'compare_pools', { chainId: SEPOLIA, tokenA: 'ETH', tokenB: 'USDC' });
    expect(out.market.error).toMatch(/subgraph/i);
    expect(out.market.pools).toEqual([]);
    expect(out.recommended?.source).toBe('execution');
  });

  it('falls back to standard fee tiers when pool_info needs a fee', async () => {
    const h = harness();
    seed(h, { poolInfoNeedsFee: true });
    const out = await ok(h, 'compare_pools', { chainId: SEPOLIA, tokenA: 'ETH', tokenB: 'USDC' });
    expect(out.execution.pools.map((p: { poolId: string }) => p.poolId)).toEqual([
      V4_ETH_USDC_POOL,
    ]);
    expect(h.http.callsTo('/lp/pool_info').length).toBe(5);
  });

  it('rejects identical tokens', async () => {
    const h = harness();
    expect(
      await fail(h, 'compare_pools', { chainId: SEPOLIA, tokenA: 'ETH', tokenB: 'ETH' })
    ).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
