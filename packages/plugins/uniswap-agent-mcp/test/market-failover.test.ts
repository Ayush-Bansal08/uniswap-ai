/**
 * Market-data failover: when the official v4 subgraph is unhealthy (as on 2026-10-31, when a
 * `handleSwap` "unexpected null" bug froze it), every market tool keeps working from the next
 * source, says which source it used, and skips dead sources until their cooldown expires.
 */
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../src/errors.js';
import { sqrtPriceAtTick } from '../src/v4/math.js';
import { mainnetEthPriceQuote, NOW_SEC } from './fixtures.js';
import { ETH, fail, GRAPH, harness, LP, MAINNET_USDC, ok, SEPOLIA, TRADE } from './helpers.js';

const OFFICIAL = `${GRAPH}/test-graph-key/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`;
const REGISTRY = `${GRAPH}/test-graph-key/subgraphs/id/6XvRX3WHSvzBVTiPdF66XSBVbxWuHqijWANbjJxRDyzr`;
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/eth';
const USDC = MAINNET_USDC.toLowerCase();
const HOOK = '0x0000000000000000000000000000000000000080';

const P_DEEP = `0x${'d1'.repeat(32)}`;
const P_SMALL = `0x${'5a'.repeat(32)}`;
const P_HOOK = `0x${'4b'.repeat(32)}`;

const registryPool = (
  poolId: string,
  fee: number,
  tickSpacing: number,
  hooks = ETH,
  ts = NOW_SEC - 30 * 86_400
) => ({
  poolId,
  currency0: ETH,
  currency1: USDC,
  fee,
  tickSpacing,
  hooks,
  blockNumber: '21000000',
  blockTimestamp: String(ts),
});

const RESERVES: Record<string, [string, string]> = {
  [P_DEEP]: ['1000000000000000000000', '2000000000000'], // 1000 ETH + 2,000,000 USDC
  [P_SMALL]: ['1000000000000000000', '3000000000'], // 1 ETH + 3,000 USDC
  [P_HOOK]: ['0', '0'],
};

/** Official subgraph answers _meta with hasIndexingErrors=true and refuses data queries. */
function officialDown(h: ReturnType<typeof harness>) {
  h.http.on('POST', OFFICIAL, (req) =>
    (req.body as { query: string }).query.includes('pools(') ||
    (req.body as { query: string }).query.includes('Datas(')
      ? {
          body: {
            errors: [{ message: 'bad indexers: BadResponse(no attestation: indexing_error)' }],
          },
        }
      : {
          body: {
            data: {
              _meta: {
                block: { number: 26352937, timestamp: NOW_SEC - 10 },
                hasIndexingErrors: true,
              },
            },
          },
        }
  );
}

function registryUp(h: ReturnType<typeof harness>) {
  h.http.on('POST', REGISTRY, (req) => {
    const q = (req.body as { query: string }).query;
    if (q.includes('hooks_not')) {
      return {
        body: { data: { pools: [registryPool(P_HOOK, 0x800000, 60, HOOK, NOW_SEC - 3_600)] } },
      };
    }
    if (q.includes('hooks: $hook')) {
      return {
        body: { data: { pools: [registryPool(P_HOOK, 0x800000, 60, HOOK, NOW_SEC - 2 * 86_400)] } },
      };
    }
    return {
      body: {
        data: {
          pools: [
            registryPool(P_SMALL, 3000, 60),
            registryPool(P_DEEP, 500, 10),
            registryPool(P_HOOK, 0x800000, 60, HOOK),
          ],
        },
      },
    };
  });
}

function lpApiUp(h: ReturnType<typeof harness>) {
  h.http.on('POST', `${LP}/lp/pool_info`, (req) => {
    const body = req.body as {
      chainId: number;
      poolReferences?: { referenceIdentifier: string }[];
    };
    if (body.chainId !== 1) return { body: { requestId: 'x', pools: [] } };
    return {
      body: {
        requestId: 'x',
        pools: (body.poolReferences ?? []).map(({ referenceIdentifier: id }) => ({
          poolReferenceIdentifier: id,
          poolProtocol: 'V4',
          tokenAddressA: ETH,
          tokenAddressB: MAINNET_USDC,
          tokenDecimalsA: '18',
          tokenDecimalsB: '6',
          fee: id === P_DEEP ? 500 : id === P_SMALL ? 3000 : 0x800000,
          tickSpacing: id === P_DEEP ? 10 : 60,
          hookAddress: id === P_HOOK ? HOOK : ETH,
          token0Reserves: RESERVES[id]![0],
          token1Reserves: RESERVES[id]![1],
        })),
      },
    };
  });
}

function geckoUp(h: ReturnType<typeof harness>) {
  h.http.on('GET', /\/networks\/eth\/pools\/0x[0-9a-f]{64}\/ohlcv\/day/, {
    body: {
      data: {
        attributes: {
          ohlcv_list: Array.from({ length: 7 }, (_, i) => [
            NOW_SEC - i * 86_400,
            3000,
            3100,
            2900,
            3050,
            100_000,
          ]),
        },
      },
    },
  });
  h.http.on('GET', /\/networks\/eth\/pools\/multi\//, {
    body: {
      data: [
        {
          attributes: {
            address: P_HOOK,
            name: 'ETH / USDC',
            reserve_in_usd: '4321.5',
            volume_usd: { h24: '10' },
          },
          relationships: {
            dex: { data: { id: 'uniswap-v4-ethereum' } },
            base_token: { data: { id: `eth_${ETH}` } },
            quote_token: { data: { id: `eth_${USDC}` } },
          },
        },
      ],
    },
  });
}

function ethPrice(h: ReturnType<typeof harness>) {
  h.http.on('POST', `${TRADE}/quote`, { body: mainnetEthPriceQuote('3200000000') });
}

describe('pool listing failover (compare_pools market half)', () => {
  it('official down → pool registry + LP API reserves (TVL) + GeckoTerminal volume (APR)', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    lpApiUp(h);
    geckoUp(h);
    ethPrice(h);
    const out = await ok(h, 'compare_pools', { chainId: SEPOLIA, tokenA: 'ETH', tokenB: 'USDC' });

    expect(out.market.source).toBe('Uniswap V4 pool registry subgraph');
    expect(out.market.error).toBeNull();
    expect(out.market.warnings.join(' | ')).toMatch(
      /Skipped uniswap-v4-subgraph: official v4 subgraph reports hasIndexingErrors=true/
    );
    const deep = out.market.pools.find((p: { poolId: string }) => p.poolId === P_DEEP);
    // TVL = 1000 ETH × $3200 + 2,000,000 USDC × $1
    expect(deep).toMatchObject({
      fee: 500,
      tickSpacing: 10,
      tvlUsd: '5200000',
      volume7dUsd: '700000',
      fees7dUsd: '350',
    });
    // APR = 350 × 52 / 5.2M × 100
    expect(deep.feeAprPct).toBe('0.35');
    expect(out.market.pools[0].poolId).toBe(P_DEEP); // sorted by TVL
    const hooked = out.market.pools.find((p: { poolId: string }) => p.poolId === P_HOOK);
    expect(hooked).toMatchObject({ isDynamicFee: true, fees7dUsd: null });
  });

  it('LP API down → TVL from GeckoTerminal, with a warning', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    geckoUp(h);
    ethPrice(h);
    h.http.on('POST', `${LP}/lp/pool_info`, { status: 503, body: { message: 'unavailable' } });
    const out = await ok(h, 'compare_pools', { chainId: SEPOLIA, tokenA: 'ETH', tokenB: 'USDC' });
    expect(out.market.warnings.join(' ')).toMatch(/LP API reserves unavailable/);
    expect(out.market.pools.find((p: { poolId: string }) => p.poolId === P_HOOK).tvlUsd).toBe(
      '4321.5'
    );
  });
});

describe('price history failover', () => {
  const ETH_TICK = -196_300;

  function onchainPrices(h: ReturnType<typeof harness>) {
    // Price rises one tick per 600 blocks so the series is visibly ordered.
    h.main.slot0At = (poolId, block) =>
      poolId === P_DEEP
        ? {
            sqrtPriceX96: sqrtPriceAtTick(ETH_TICK + Number((block - 6_990_000n) / 600n)),
            tick: 0,
            protocolFee: 0,
            lpFee: 500,
          }
        : new Error('unexpected pool');
  }

  it('official down → Uniswap v4 StateView at historical blocks on the deepest hookless pool', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    lpApiUp(h);
    geckoUp(h);
    ethPrice(h);
    onchainPrices(h);
    const out = await ok(h, 'get_price_history', {
      symbol: 'ETH',
      window: '24h',
      interval: 'hour',
    });
    expect(out.source).toMatchObject({
      provider: 'uniswap-v4-stateview',
      kind: 'pool',
      id: P_DEEP,
    });
    expect(out.series).toHaveLength(25);
    const prices = out.series.map((p: { priceUsd: string }) => Number(p.priceUsd));
    expect(prices.every((p: number, i: number) => i === 0 || p >= prices[i - 1]!)).toBe(true);
    expect(prices[0]).toBeGreaterThan(2000);
    expect(prices.at(-1)).toBeLessThan(4000);
    expect(out.hasIndexingErrors).toBeNull();
    expect(out.stale).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/Pool chosen from Uniswap V4 pool registry subgraph/);
  });

  it('no archive RPC → GeckoTerminal OHLCV', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    lpApiUp(h);
    ethPrice(h);
    h.main.slot0At = () =>
      new McpToolError('RPC_ERROR', 'RPC (chain 1) StateView.getSlot0 failed: missing trie node');
    h.http.on('GET', `${GECKO}/tokens/${USDC}/pools`, {
      body: {
        data: [
          {
            attributes: {
              address: P_DEEP,
              name: 'ETH / USDC 0.05%',
              reserve_in_usd: '5200000',
              volume_usd: { h24: '1' },
            },
            relationships: {
              dex: { data: { id: 'uniswap-v4-ethereum' } },
              base_token: { data: { id: `eth_${ETH}` } },
              quote_token: { data: { id: `eth_${USDC}` } },
            },
          },
        ],
      },
    });
    h.http.on('GET', /\/pools\/0x[0-9a-f]{64}\/ohlcv\/hour/, {
      body: {
        data: {
          attributes: {
            ohlcv_list: [
              [NOW_SEC - 3_600, 3000, 3010, 2990, 3005, 1],
              [NOW_SEC - 7_200, 2990, 3000, 2980, 2999, 1],
            ],
          },
        },
      },
    });
    const out = await ok(h, 'get_price_history', {
      symbol: 'ETH',
      window: '24h',
      interval: 'hour',
    });
    expect(out.source.provider).toBe('geckoterminal');
    expect(out.series.map((p: { priceUsd: string }) => p.priceUsd)).toEqual(['2999', '3005']);
    expect(out.warnings.join(' ')).toMatch(/uniswap-v4-stateview.*missing trie node/);
    const ohlcv = h.http.callsTo('/ohlcv/hour')[0]!;
    expect(ohlcv.url).toContain('token=base');
  });
});

describe('hook discovery failover', () => {
  it('list_new_hooks market: official down → registry, TVL from GeckoTerminal', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    geckoUp(h);
    const out = await ok(h, 'list_new_hooks', { scope: 'market', sinceDays: 3 });
    expect(out.source).toBe('Uniswap V4 pool registry subgraph');
    expect(out.hooks).toEqual([
      expect.objectContaining({
        hookAddress: HOOK,
        totalTvlUsd: '4321.5',
        firstSeen: new Date((NOW_SEC - 3_600) * 1000).toISOString(),
      }),
    ]);
    expect(out.hooks[0].pools[0]).toMatchObject({
      isDynamicFee: true,
      token0Symbol: 'ETH',
      token1Symbol: 'USDC',
    });
  });

  it('score_hook on mainnet: official down → registry for pools, age and dynamic fees', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    geckoUp(h);
    h.main.code.set(HOOK, '0x6080604052');
    const out = await ok(h, 'score_hook', { chainId: 1, hookAddress: HOOK });
    expect(out.facts).toMatchObject({ poolCount: 1, dynamicFeePoolCount: 1, tvlUsd: '4321.50' });
    expect(out.facts.ageSource).toMatch(/^Uniswap V4 pool registry subgraph/);
    expect(out.breakdown.map((b: { rule: string }) => b.rule)).toEqual([
      'high_risk_callbacks',
      'unverified_source',
      'young_hook',
      'dynamic_fee_pool',
    ]);
  });

  it('get_hook_state on mainnet discovers pools through the registry', async () => {
    const h = harness();
    officialDown(h);
    registryUp(h);
    geckoUp(h);
    h.main.code.set(HOOK, '0x6080604052');
    h.main.slot0.set(P_HOOK, {
      sqrtPriceX96: sqrtPriceAtTick(-196_300),
      tick: -196_300,
      protocolFee: 0,
      lpFee: 4000,
    });
    const out = await ok(h, 'get_hook_state', { chainId: 1, hookAddress: HOOK });
    expect(out.poolDiscovery).toBe('registry');
    expect(out.pools).toEqual([expect.objectContaining({ poolId: P_HOOK, lpFee: 4000 })]);
  });
});

describe('source health (circuit breaker)', () => {
  it('skips a failed source during its cooldown, then retries it', async () => {
    const h = harness();
    officialDown(h);
    h.http.on('POST', REGISTRY, { status: 500, body: {} });
    h.main.code.set('0x000000000004444c5dc75cb358380d2e3de08a90', '0x6080');
    h.main.initializeLogs = [
      {
        poolId: P_HOOK as Hex,
        currency0: ETH,
        currency1: MAINNET_USDC,
        fee: 3000,
        tickSpacing: 60,
        hooks: HOOK,
        blockNumber: 6_999_500n,
      },
    ];

    const first = await ok(h, 'list_new_hooks', { scope: 'market', sinceDays: 1 });
    expect(first.source).toBe('Uniswap v4 PoolManager Initialize logs (RPC)');
    const registryCalls = h.http.callsTo('6XvRX3').length;
    expect(registryCalls).toBe(4); // 1 call + 3 retries (5xx)

    const second = await ok(h, 'list_new_hooks', { scope: 'market', sinceDays: 2 });
    expect(second.warnings.join(' ')).toMatch(/Skipped uniswap-v4-pool-registry: cooling down/);
    expect(h.http.callsTo('6XvRX3').length).toBe(registryCalls); // not called again

    h.clock.now += 61_000; // past MARKET_SOURCE_COOLDOWN_MS
    await ok(h, 'list_new_hooks', { scope: 'market', sinceDays: 3 });
    expect(h.http.callsTo('6XvRX3').length).toBeGreaterThan(registryCalls);
    expect(
      h.deps.health.snapshot().find((s) => s.name === 'uniswap-v4-pool-registry')?.status
    ).toBe('down');
  });

  it('every source down → MARKET_DATA_UNAVAILABLE listing each source and reason', async () => {
    const h = harness();
    officialDown(h);
    h.http.on('POST', REGISTRY, { status: 500, body: {} });
    h.http.on('GET', /geckoterminal/, { status: 500, body: {} });
    const err = await fail(h, 'get_price_history', {
      symbol: 'ETH',
      window: '24h',
      interval: 'hour',
    });
    expect(err).toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE', retryable: true });
    const skipped = (err.details as { skipped: { source: string }[] }).skipped.map((s) => s.source);
    expect(skipped).toEqual(['uniswap-v4-subgraph', 'uniswap-v4-stateview', 'geckoterminal']);
  });
});
