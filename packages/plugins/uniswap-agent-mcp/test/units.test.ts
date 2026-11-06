import { encodeAbiParameters, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { formatUsd, toRaw } from '../src/amounts.js';
import { TtlCache } from '../src/cache.js';
import { CHAINS, getChain, requireChainAddress } from '../src/chains.js';
import { createResilientFetch } from '../src/clients/http.js';
import { ConfigError, loadConfig, resolvePort } from '../src/config.js';
import { McpToolError } from '../src/errors.js';
import { ResumeTokens } from '../src/resume.js';
import { checkBuildResult } from '../src/schemas.js';
import { derivePrimaryType, normalizePermit } from '../src/services/typedData.js';
import { validateTx } from '../src/tx.js';
import {
  decodePositionInfo,
  poolIdOf,
  rangeToTicks,
  sqrtPriceAtTick,
  uncollectedFees,
} from '../src/v4/math.js';
import { V4_ETH_USDC_POOL } from './fixtures.js';
import {
  encodePositionInfo,
  ETH,
  OTHER,
  SEPOLIA,
  SEPOLIA_USDC,
  SWAPPER,
  TEST_ENV,
} from './helpers.js';

describe('tx validation', () => {
  const tx = {
    to: SEPOLIA_USDC,
    from: SWAPPER.toLowerCase(),
    data: '0x095ea7b3',
    value: '0',
    chainId: SEPOLIA,
  };
  it('checksums addresses and passes calldata through unchanged', () => {
    const step = validateTx('APPROVAL', 'Approve', tx, {
      chainId: SEPOLIA,
      from: SWAPPER,
      allowedTo: [SEPOLIA_USDC],
    });
    expect(step.tx).toEqual({
      to: SEPOLIA_USDC,
      from: SWAPPER,
      data: '0x095ea7b3',
      value: '0',
      chainId: SEPOLIA,
    });
  });
  it.each([
    [{ data: '' }, /empty/],
    [{ data: '0xzz' }, /not valid hex/],
    [{ to: '0x123' }, /invalid "to"/],
    [{ from: OTHER }, /does not match/],
    [{ chainId: 1 }, /chainId/],
    [{ value: '-1' }, /wei integer/],
    [{ maxFeePerGas: '1', gasPrice: '1' }, /both/],
  ])('rejects %o', (override, msg) => {
    expect(() =>
      validateTx('SWAP', 'x', { ...tx, ...override }, { chainId: SEPOLIA, from: SWAPPER })
    ).toThrow(msg);
  });
});

describe('resume tokens', () => {
  const args = { chainId: 1, amount: '1' };
  it('round-trips, binds to tool + args, expires after 120 s', () => {
    let now = 1_000;
    const r = new ResumeTokens('s'.repeat(40), () => now);
    const { token } = r.issue('build_swap', args, { a: 1 });
    expect(r.verify('build_swap', { ...args, resumeToken: token, signature: '0x' }, token)).toEqual(
      { a: 1 }
    );
    expect(() => r.verify('build_lp_position', args, token)).toThrow(McpToolError);
    expect(() => r.verify('build_swap', { ...args, amount: '2' }, token)).toThrow(/does not match/);
    expect(() =>
      new ResumeTokens('t'.repeat(40), () => now).verify('build_swap', args, token)
    ).toThrow(/integrity/);
    now += 120_001;
    expect(() => r.verify('build_swap', args, token)).toThrow(/expired/);
  });
});

describe('amounts', () => {
  it('converts without silent rounding', () => {
    expect(toRaw('1.5', 6)).toBe(1_500_000n);
    expect(toRaw('0.000001', 6)).toBe(1n);
    expect(toRaw('1.000', 6)).toBe(1_000_000n);
    expect(() => toRaw('0.0000001', 6)).toThrow(/decimal places/);
    expect(() => toRaw('-1', 6)).toThrow();
    expect(formatUsd('3312.4')).toBe('$3,312.40');
    expect(formatUsd('0.5')).toBe('$0.5000');
  });
});

describe('v4 math', () => {
  it('poolId from the SDK equals keccak256(abi.encode(PoolKey))', () => {
    const t0 = { address: ETH, symbol: 'ETH', decimals: 18, isNative: true };
    const t1 = { address: SEPOLIA_USDC, symbol: 'USDC', decimals: 6, isNative: false };
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'address' },
          { type: 'uint24' },
          { type: 'int24' },
          { type: 'address' },
        ],
        [ETH, SEPOLIA_USDC, 3000, 60, ETH]
      )
    );
    expect(poolIdOf(SEPOLIA, t0, t1, 3000, 60, ETH)).toBe(expected);
    expect(expected).toBe(V4_ETH_USDC_POOL);
  });

  it('decodes PositionInfo (ticks are int24)', () => {
    const info = encodePositionInfo(V4_ETH_USDC_POOL, -196860, 120);
    expect(decodePositionInfo(info)).toMatchObject({
      tickLower: -196860,
      tickUpper: 120,
      hasSubscriber: false,
    });
    expect(decodePositionInfo(info).poolIdPrefix).toBe(V4_ETH_USDC_POOL.slice(0, 52));
  });

  it('range presets bracket the current tick and snap to the spacing', () => {
    for (const preset of ['narrow', 'medium', 'wide'] as const) {
      const { tickLower, tickUpper } = rangeToTicks({
        range: { preset },
        currentTick: -196300,
        tickSpacing: 60,
        decimals0: 18,
        decimals1: 6,
      });
      expect(tickLower).toBeLessThan(-196300);
      expect(tickUpper).toBeGreaterThan(-196300);
      expect(Math.abs(tickLower % 60) + Math.abs(tickUpper % 60)).toBe(0);
    }
    expect(() =>
      rangeToTicks({
        range: { minPrice: '3', maxPrice: '2' },
        currentTick: 0,
        tickSpacing: 60,
        decimals0: 18,
        decimals1: 6,
      })
    ).toThrow();
  });

  it('uncollected fees wrap like uint256', () => {
    expect(uncollectedFees(10n, 5n << 128n, 2n << 128n)).toBe(30n);
    expect(uncollectedFees(1n, 0n, (1n << 256n) - (1n << 128n))).toBe(1n);
    expect(sqrtPriceAtTick(0)).toBe(1n << 96n);
  });
});

describe('typed data normalisation', () => {
  it('derives the primary type and unwraps proto fields', () => {
    expect(
      derivePrimaryType({ A: [{ name: 'b', type: 'B[]' }], B: [{ name: 'x', type: 'uint256' }] })
    ).toBe('A');
    const sig = normalizePermit(
      'V4_BATCH_PERMIT',
      {
        domain: { chainId: 'SEPOLIA', name: 'Permit2' },
        types: { EIP712Domain: [], P: { fields: [{ name: 'x', type: 'uint256' }] } },
        values: { x: '1' },
      },
      SEPOLIA
    );
    expect(sig.typedData).toEqual({
      domain: { chainId: SEPOLIA, name: 'Permit2' },
      types: { P: [{ name: 'x', type: 'uint256' }] },
      primaryType: 'P',
      message: { x: '1' },
    });
  });
});

describe('build result consistency', () => {
  it('flags inconsistent results', () => {
    expect(checkBuildResult({ status: 'READY', steps: [], summary: {} })).toContain(
      'READY requires steps'
    );
    expect(checkBuildResult({ status: 'NEEDS_SIGNATURE', summary: {} })).toHaveLength(3);
  });
});

describe('chains (vendor-doc addresses only)', () => {
  it('has the Sepolia v4 deployment and fails loudly on missing tokens', () => {
    expect(getChain(SEPOLIA)).toMatchObject({
      poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
      universalRouter: { '2.1.2': '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3' },
      usdc: SEPOLIA_USDC,
      weth: null,
    });
    expect(() => requireChainAddress(SEPOLIA, 'weth')).toThrow(
      /not listed in the vendored Uniswap docs/
    );
    expect(() => getChain(137)).toThrow(McpToolError);
    expect(Object.keys(CHAINS)).toEqual(['1', '1301', '84532', '11155111']);
  });
});

describe('config', () => {
  it('lists every missing variable and validates the allowlist JSON', () => {
    try {
      loadConfig({});
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues;
      for (const key of [
        'UNISWAP_API_KEY',
        'EXECUTION_RPC_URL',
        'MAINNET_RPC_URL',
        'MCP_RESUME_SECRET',
      ]) {
        expect(issues).toContain(`${key} is required but missing`);
      }
    }
    expect(() => loadConfig({ ...TEST_ENV, TOKEN_ALLOWLIST_JSON: '{bad' })).toThrow(/valid JSON/);
    const cfg = loadConfig({
      ...TEST_ENV,
      TOKEN_ALLOWLIST_JSON: JSON.stringify([
        { chainId: SEPOLIA, address: OTHER, symbol: 'LINK', decimals: 18 },
      ]),
    });
    expect(cfg.TOKEN_ALLOWLIST_JSON).toHaveLength(1);
    expect(resolvePort(cfg)).toBe(3002);
    expect(resolvePort({ ...cfg, PORT: 8080 })).toBe(8080);
    expect(resolvePort({ ...cfg, MCP_PORT: 9000, PORT: 8080 }, 7000)).toBe(7000);
  });
});

describe('http retry + cache', () => {
  it('times out each attempt and gives up after 3 retries', async () => {
    let calls = 0;
    const slow = createResilientFetch({
      fetch: (_u, init) =>
        new Promise((_r, reject) => {
          calls += 1;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError'))
          );
        }),
      timeoutMs: 20,
      sleep: async () => undefined,
    });
    await expect(slow('https://example.invalid/x')).rejects.toThrow(/timed out/);
    expect(calls).toBe(4);
  });

  it('single-flights concurrent computations', async () => {
    const cache = new TtlCache();
    let n = 0;
    const compute = async () => ++n;
    const [a, b] = await Promise.all([
      cache.wrap('k', 1000, compute),
      cache.wrap('k', 1000, compute),
    ]);
    expect([a, b, n]).toEqual([1, 1, 1]);
  });
});
