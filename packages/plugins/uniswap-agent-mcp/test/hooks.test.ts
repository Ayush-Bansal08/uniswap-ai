import { toFunctionSelector, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../src/errors.js';
import {
  decodeHookPermissions,
  enabledPermissions,
  permissionsBitmap,
} from '../src/hooks/permissions.js';
import { bandFor, computeHookScore } from '../src/hooks/score.js';
import type { HookFacts } from '../src/schemas.js';
import { minimalProxyTarget, PROXY_SLOTS, scanAdminSelectors } from '../src/services/hookFacts.js';
import { sqrtPriceAtTick } from '../src/v4/math.js';
import { NOW_SEC, subgraphResponse } from './fixtures.js';
import {
  ETH,
  fail,
  GRAPH,
  harness,
  MAINNET,
  MAINNET_USDC,
  ok,
  SEPOLIA,
  SEPOLIA_USDC,
} from './helpers.js';

const POOL_MANAGER = '0xe03a1074c86cfedd5c142c4f04f1a1536e203543';
const GRAPH_URL = `${GRAPH}/test-graph-key/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`;

describe('hooks/permissions — address bits → flags (v4-core Hooks.sol)', () => {
  const cases: [string, string[]][] = [
    ['0x0000000000000000000000000000000000000000', []],
    ['0x0000000000000000000000000000000000002000', ['beforeInitialize']],
    ['0x0000000000000000000000000000000000001000', ['afterInitialize']],
    ['0x0000000000000000000000000000000000000080', ['beforeSwap']],
    ['0x00000000000000000000000000000000000000c0', ['beforeSwap', 'afterSwap']],
    ['0x0000000000000000000000000000000000000088', ['beforeSwap', 'beforeSwapReturnDelta']],
    ['0x0000000000000000000000000000000000000a00', ['beforeAddLiquidity', 'beforeRemoveLiquidity']],
    [
      '0x0000000000000000000000000000000000000003',
      ['afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta'],
    ],
    // Only the low 14 bits matter: high address bits are ignored.
    // 0xc030 & 0x3fff = 0x0030: bits 14/15 are outside the permission mask.
    ['0xffffffffffffffffffffffffffffffffffffc030', ['beforeDonate', 'afterDonate']],
    [
      '0x0000000000000000000000000000000000003fff',
      [
        'beforeInitialize',
        'afterInitialize',
        'beforeAddLiquidity',
        'afterAddLiquidity',
        'beforeRemoveLiquidity',
        'afterRemoveLiquidity',
        'beforeSwap',
        'afterSwap',
        'beforeDonate',
        'afterDonate',
        'beforeSwapReturnDelta',
        'afterSwapReturnDelta',
        'afterAddLiquidityReturnDelta',
        'afterRemoveLiquidityReturnDelta',
      ],
    ],
  ];
  it.each(cases)('%s', (address, expected) => {
    const p = decodeHookPermissions(address);
    expect(
      Object.entries(p)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort()
    ).toEqual([...expected].sort());
  });

  it('reports risk levels from the security-foundations matrix', () => {
    const enabled = enabledPermissions(
      decodeHookPermissions('0x0000000000000000000000000000000000000088')
    );
    expect(enabled).toEqual([
      { flag: 'beforeSwap', bit: 7, risk: 'HIGH' },
      { flag: 'beforeSwapReturnDelta', bit: 3, risk: 'CRITICAL' },
    ]);
    expect(permissionsBitmap('0x0000000000000000000000000000000000003fff')).toBe(0x3fff);
  });
});

function facts(overrides: Partial<HookFacts> = {}): HookFacts {
  return {
    hasCode: true,
    codeSizeBytes: 4000,
    codeHash: `0x${'ab'.repeat(32)}`,
    proxy: { kind: null, implementation: null, admin: null, beacon: null, upgradeable: false },
    owner: null,
    adminSelectors: [],
    verifiedSource: true,
    contractName: 'Hook',
    firstSeenBlock: '1',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    ageDays: 300,
    ageSource: 'test',
    poolCount: 1,
    dynamicFeePoolCount: 0,
    tvlUsd: null,
    ...overrides,
  };
}

describe('hooks/score — deterministic score', () => {
  const now = new Date('2026-11-06T12:00:00Z');

  it('proxy + return-delta + unverified → DANGER', () => {
    const hook = '0x00000000000000000000000000000000000000cc'; // beforeSwap, afterSwap, both swap return deltas
    const out = computeHookScore({
      chainId: 1,
      hookAddress: hook,
      permissions: decodeHookPermissions(hook),
      facts: facts({
        proxy: {
          kind: 'EIP1967',
          implementation: '0x1234567890123456789012345678901234567890',
          admin: null,
          beacon: null,
          upgradeable: true,
        },
        verifiedSource: false,
      }),
      now,
    });
    expect(out.band).toBe('DANGER');
    expect(out.score).toBe(100 - 40 - 5 - 20 - 15);
    expect(out.breakdown.map((b) => b.rule)).toEqual([
      'return_delta_permissions',
      'high_risk_callbacks',
      'upgradeable_proxy',
      'unverified_source',
    ]);
    expect(out.breakdown.every((b) => b.source.length > 10 && b.evidence.length > 5)).toBe(true);
    const triggered = out.framework.featureTriggers
      .filter((t) => t.triggered)
      .map((t) => t.feature);
    expect(triggered).toEqual(
      expect.arrayContaining([
        'Custom curve or non standard math',
        'Price impacting behavior',
        'Upgradeable',
      ])
    );
    expect(out.framework.riskScore.tierAtLeast).toBe('Medium');
  });

  it('plain verified hook without deltas → SAFE (100)', () => {
    const hook = '0x0000000000000000000000000000000000000040'; // afterSwap only (MEDIUM)
    const out = computeHookScore({
      chainId: 1,
      hookAddress: hook,
      permissions: decodeHookPermissions(hook),
      facts: facts(),
      now,
    });
    expect(out).toMatchObject({ score: 100, band: 'SAFE', breakdown: [] });
  });

  it('no code → DANGER regardless; caps and small penalties apply', () => {
    const hook = '0x000000000000000000000000000000000000000f';
    const noCode = computeHookScore({
      chainId: 1,
      hookAddress: hook,
      permissions: decodeHookPermissions(hook),
      facts: facts({ hasCode: false }),
      now,
    });
    expect(noCode.band).toBe('DANGER');
    expect(noCode.score).toBe(0);
    const young = computeHookScore({
      chainId: 1,
      hookAddress: '0x0000000000000000000000000000000000000040',
      permissions: decodeHookPermissions('0x0000000000000000000000000000000000000040'),
      facts: facts({
        ageDays: 2,
        dynamicFeePoolCount: 1,
        owner: '0x9999999999999999999999999999999999999999',
        adminSelectors: ['setFee(uint24)'],
      }),
      now,
    });
    expect(young.breakdown.map((b) => [b.rule, b.penalty])).toEqual([
      ['privileged_owner_can_change_params', 15],
      ['young_hook', 10],
      ['dynamic_fee_pool', 5],
    ]);
    expect(young.score).toBe(70);
    expect(young.band).toBe('CAUTION');
  });

  it('bands at the 80 / 50 thresholds', () => {
    expect(bandFor(80, true)).toBe('SAFE');
    expect(bandFor(79, true)).toBe('CAUTION');
    expect(bandFor(50, true)).toBe('CAUTION');
    expect(bandFor(49, true)).toBe('DANGER');
    expect(bandFor(100, false)).toBe('DANGER');
  });

  it('finds privileged setter selectors and EIP-1167 clones in bytecode', () => {
    const setFeeSelector = toFunctionSelector('setFee(uint24)').slice(2); // 0xeabb5622
    expect(scanAdminSelectors(`0x6000${'63'}${setFeeSelector}14`)).toEqual(['setFee(uint24)']);
    expect(scanAdminSelectors('0x60006001')).toEqual([]);
    const target = '1111111111111111111111111111111111111111';
    expect(
      minimalProxyTarget(`0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3` as Hex)
    ).toBe(`0x${target}`);
  });
});

describe('score_hook tool', () => {
  const ETHERSCAN = 'https://api.etherscan.io/v2/api';

  it('detects an EIP-1967 proxy with return deltas and no verified source → DANGER', async () => {
    const h = harness();
    const hook = '0x00000000000000000000000000000000000000cc';
    h.exec.code.set(hook, '0x6080604052');
    h.exec.code.set(POOL_MANAGER, '0x6080');
    h.exec.storage.set(
      `${hook}:${PROXY_SLOTS.eip1967Implementation}`,
      `0x000000000000000000000000${'12'.repeat(20)}` as Hex
    );
    const out = await ok(h, 'score_hook', { chainId: SEPOLIA, hookAddress: hook });
    expect(out.facts.proxy).toMatchObject({
      kind: 'EIP1967',
      upgradeable: true,
      implementation: `0x${'12'.repeat(20)}`,
    });
    expect(out.facts.verifiedSource).toBeNull();
    expect(out.band).toBe('DANGER');
    expect(out.permissions.beforeSwapReturnDelta).toBe(true);
  });

  it('scores a verified, old, plain hook as SAFE using Etherscan v2', async () => {
    const h = harness({ ETHERSCAN_API_KEY: 'test-etherscan-key' });
    const hook = '0x0000000000000000000000000000000000000040';
    h.exec.code.set(hook, '0x6080604052');
    h.exec.code.set(POOL_MANAGER, '0x6080');
    h.http.on('GET', ETHERSCAN, (req) =>
      req.url.includes('getsourcecode')
        ? {
            body: {
              status: '1',
              result: [
                {
                  SourceCode: 'contract H {}',
                  ContractName: 'PlainHook',
                  Proxy: '0',
                  Implementation: '',
                },
              ],
            },
          }
        : {
            body: {
              status: '1',
              result: [{ blockNumber: '100', timestamp: String(NOW_SEC - 90 * 86_400) }],
            },
          }
    );
    const out = await ok(h, 'score_hook', { chainId: SEPOLIA, hookAddress: hook });
    expect(out).toMatchObject({ score: 100, band: 'SAFE' });
    expect(out.facts).toMatchObject({
      verifiedSource: true,
      contractName: 'PlainHook',
      ageSource: 'Etherscan contract creation',
    });
    expect(Math.round(out.facts.ageDays)).toBe(90);
    const urls = h.http.callsTo('etherscan').map((c) => c.url);
    expect(urls.every((u) => u.includes('chainid=11155111'))).toBe(true);
  });

  it('uses the mainnet subgraph for pools, TVL and age on chain 1', async () => {
    const h = harness();
    const hook = '0x0000000000000000000000000000000000000080';
    h.main.code.set(hook, '0x6080604052');
    h.http.on('POST', GRAPH_URL, {
      body: subgraphResponse({
        pools: [
          {
            id: `0x${'01'.repeat(32)}`,
            feeTier: '8388608',
            tickSpacing: '60',
            hooks: hook,
            totalValueLockedUSD: '1250000.5',
            createdAtTimestamp: String(NOW_SEC - 3 * 86_400),
            createdAtBlockNumber: '23600000',
            token0: { id: ETH, symbol: 'ETH', decimals: '18' },
            token1: { id: MAINNET_USDC.toLowerCase(), symbol: 'USDC', decimals: '6' },
          },
        ],
      }),
    });
    const out = await ok(h, 'score_hook', { chainId: MAINNET, hookAddress: hook });
    expect(out.facts).toMatchObject({
      poolCount: 1,
      dynamicFeePoolCount: 1,
      tvlUsd: '1250000.50',
      ageSource: 'v4 subgraph (first pool created)',
    });
    expect(out.breakdown.map((b: { rule: string }) => b.rule)).toEqual([
      'high_risk_callbacks',
      'unverified_source',
      'young_hook',
      'dynamic_fee_pool',
    ]);
    expect(out.score).toBe(100 - 5 - 15 - 10 - 5);
  });

  it('rejects chains other than the execution chain and mainnet', async () => {
    const h = harness();
    expect(
      await fail(h, 'score_hook', {
        chainId: 8453,
        hookAddress: '0x0000000000000000000000000000000000000040',
      })
    ).toMatchObject({
      code: 'UNSUPPORTED_CHAIN',
    });
  });
});

describe('get_hook_state', () => {
  it('snapshots code hash, implementation, owner and pool state', async () => {
    const h = harness();
    const hook = '0x0000000000000000000000000000000000000080';
    const poolId = `0x${'0a'.repeat(32)}`;
    h.exec.code.set(hook, '0x6080604052');
    h.exec.code.set(`0x${'34'.repeat(20)}`, '0x60806040');
    h.exec.storage.set(
      `${hook}:${PROXY_SLOTS.eip1967Implementation}`,
      `0x000000000000000000000000${'34'.repeat(20)}` as Hex
    );
    h.exec.owners.set(hook, '0x9999999999999999999999999999999999999999');
    h.exec.slot0.set(poolId, {
      sqrtPriceX96: sqrtPriceAtTick(-200000),
      tick: -200000,
      protocolFee: 0,
      lpFee: 4200,
    });
    h.exec.liquidity.set(poolId, 123n);
    const out = await ok(h, 'get_hook_state', {
      chainId: SEPOLIA,
      hookAddress: hook,
      poolIds: [poolId],
    });
    expect(out).toMatchObject({
      hasCode: true,
      implementation: `0x${'34'.repeat(20)}`,
      owner: '0x9999999999999999999999999999999999999999',
      permissionsBitmap: 0x80,
      poolDiscovery: 'input',
      blockNumber: '7000000',
    });
    expect(out.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.implementationCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.pools).toEqual([
      {
        poolId,
        lpFee: 4200,
        protocolFee: 0,
        sqrtPriceX96: sqrtPriceAtTick(-200000).toString(),
        tick: -200000,
        liquidity: '123',
      },
    ]);
  });
});

describe('list_new_hooks', () => {
  it('execution: scans Initialize logs in windows (halving on RPC range errors) and groups by hook', async () => {
    const h = harness();
    h.exec.code.set(POOL_MANAGER, '0x6080');
    const hookA = '0x00000000000000000000000000000000000000c0' as Address;
    const hookB = '0x0000000000000000000000000000000000000080' as Address;
    const log = (poolByte: string, hooks: Address, block: bigint, fee = 3000) => ({
      poolId: `0x${poolByte.repeat(32)}` as Hex,
      currency0: ETH,
      currency1: SEPOLIA_USDC,
      fee,
      tickSpacing: 60,
      hooks,
      blockNumber: block,
    });
    h.exec.initializeLogs = [
      log('01', hookA, 6_990_000n),
      log('02', hookA, 6_995_000n, 0x800000),
      log('03', hookB, 6_999_000n),
      log('04', ETH, 6_999_500n),
    ];
    let rejected = 0;
    h.exec.getLogsHook = (from, to) => {
      if (to - from + 1n > 2_500n) {
        rejected += 1;
        throw new McpToolError(
          'RPC_ERROR',
          'RPC (chain 11155111) eth_getLogs failed: block range too large'
        );
      }
    };
    const out = await ok(h, 'list_new_hooks', { scope: 'execution', sinceDays: 7 });
    expect(rejected).toBeGreaterThan(0);
    expect(out.chainId).toBe(SEPOLIA);
    expect(out.hooks.map((x: { hookAddress: string }) => x.hookAddress)).toEqual([hookB, hookA]);
    expect(out.hooks[1].pools).toHaveLength(2);
    expect(out.hooks[1].pools[1].isDynamicFee).toBe(true);
    expect(out.hooks[0].firstSeen).toBe(new Date((NOW_SEC - 1000 * 12) * 1000).toISOString());
    expect(BigInt(out.scannedFromBlock)).toBe(7_000_000n - 7n * 7_200n);
  });

  it('market: groups subgraph hook pools, newest first, with TVL', async () => {
    const h = harness();
    const pool = (id: string, hooks: string, created: number, tvl: string) => ({
      id,
      feeTier: '3000',
      tickSpacing: '60',
      hooks,
      totalValueLockedUSD: tvl,
      createdAtTimestamp: String(created),
      createdAtBlockNumber: '23600000',
      token0: { id: ETH, symbol: 'ETH', decimals: '18' },
      token1: { id: MAINNET_USDC.toLowerCase(), symbol: 'USDC', decimals: '6' },
    });
    h.http.on('POST', GRAPH_URL, {
      body: subgraphResponse({
        pools: [
          pool(
            `0x${'0b'.repeat(32)}`,
            '0x0000000000000000000000000000000000000080',
            NOW_SEC - 1000,
            '500'
          ),
          pool(
            `0x${'0c'.repeat(32)}`,
            '0x00000000000000000000000000000000000000c0',
            NOW_SEC - 5000,
            '1000'
          ),
          pool(
            `0x${'0d'.repeat(32)}`,
            '0x00000000000000000000000000000000000000c0',
            NOW_SEC - 9000,
            '250.25'
          ),
        ],
      }),
    });
    const out = await ok(h, 'list_new_hooks', {
      scope: 'market',
      sinceDays: 3,
      pair: ['ETH', 'USDC'],
      limit: 10,
    });
    expect(out.hooks).toHaveLength(2);
    expect(out.hooks[0].hookAddress).toBe('0x0000000000000000000000000000000000000080');
    expect(out.hooks[1]).toMatchObject({ totalTvlUsd: '1250.25' });
    expect(out.hooks[1].pools).toHaveLength(2);
    const vars = (
      h.http.callsTo('/subgraphs/id/')[0]!.body as { variables: Record<string, unknown> }
    ).variables;
    expect(vars).toMatchObject({
      t0: ETH,
      t1: MAINNET_USDC.toLowerCase(),
      since: String(NOW_SEC - 3 * 86_400),
    });
  });

  it('market: fails clearly without THEGRAPH_API_KEY', async () => {
    const h = harness({ THEGRAPH_API_KEY: undefined });
    expect(await fail(h, 'list_new_hooks', { scope: 'market' })).toMatchObject({
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  });
});
