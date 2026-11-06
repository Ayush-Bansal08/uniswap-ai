import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { BuildLpPositionInputSchema } from '../src/schemas.js';
import { sqrtPriceAtTick } from '../src/v4/math.js';
import {
  APPROVE_PERMIT2_CALLDATA,
  lpClaimResponse,
  lpCreateResponse,
  lpDecreaseResponse,
  V4_BATCH_PERMIT_PROTO,
  V4_ETH_USDC_POOL,
} from './fixtures.js';
import {
  encodePositionInfo,
  ETH,
  fail,
  harness,
  LP,
  ok,
  OTHER,
  SEPOLIA,
  SEPOLIA_PM,
  SEPOLIA_USDC,
  SWAPPER,
} from './helpers.js';

const TICK = -196300;
const POOL_KEY = {
  currency0: ETH,
  currency1: SEPOLIA_USDC,
  fee: 3000,
  tickSpacing: 60,
  hooks: ETH,
} as const;
const SIG = `0x${'cd'.repeat(65)}`;

function seed(h: ReturnType<typeof harness>) {
  h.exec.poolKeys.set(V4_ETH_USDC_POOL, POOL_KEY);
  h.exec.slot0.set(V4_ETH_USDC_POOL, {
    sqrtPriceX96: sqrtPriceAtTick(TICK),
    tick: TICK,
    protocolFee: 0,
    lpFee: 3000,
  });
  h.exec.liquidity.set(V4_ETH_USDC_POOL, 5_000_000_000_000_000n);
  h.exec.balances.set(SWAPPER.toLowerCase(), 10n ** 18n);
  h.exec.positions.set('42', {
    poolKey: POOL_KEY,
    info: encodePositionInfo(V4_ETH_USDC_POOL as Hex, -196860, -195780),
    liquidity: 2_000_000_000_000n,
    owner: SWAPPER,
  });
  h.exec.feeState = {
    liquidity: 2_000_000_000_000n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    feeGrowthInside0X128: 1n << 128n,
    feeGrowthInside1X128: 0n,
  };
}

function approvalBody(withPermit: boolean, kyc = false) {
  return {
    requestId: 'lp-appr-1',
    transactions: [
      {
        transaction: {
          to: SEPOLIA_USDC,
          from: SWAPPER,
          data: APPROVE_PERMIT2_CALLDATA,
          value: '0',
          chainId: SEPOLIA,
        },
        cancelApproval: false,
        action: 'CREATE',
      },
    ],
    v4BatchPermitData: withPermit ? V4_BATCH_PERMIT_PROTO : null,
    kycRequiredWarnings: kyc
      ? [{ kycUrl: 'https://kyc.example/verify', tokenAddress: SEPOLIA_USDC, chainId: SEPOLIA }]
      : [],
  };
}

const lpArgs = {
  chainId: SEPOLIA,
  owner: SWAPPER,
  pool: { poolReference: V4_ETH_USDC_POOL, token0: 'ETH', token1: 'USDC' },
  independentToken: { token: 'ETH', amount: '0.001' },
  range: { preset: 'narrow' },
  slippagePct: 0.5,
};

describe('build_transfer', () => {
  it('native ETH: value transfer with no calldata', async () => {
    const h = harness();
    h.exec.balances.set(SWAPPER.toLowerCase(), 10n ** 18n);
    const out = await ok(h, 'build_transfer', {
      chainId: SEPOLIA,
      from: SWAPPER,
      token: 'ETH',
      amount: '0.05',
      to: OTHER,
    });
    expect(out.steps).toEqual([
      {
        kind: 'TRANSFER',
        description: `Send 0.05 ETH to ${OTHER}`,
        tx: { to: OTHER, from: SWAPPER, data: '0x', value: '50000000000000000', chainId: SEPOLIA },
      },
    ]);
    expect(out.warnings).toBeUndefined();
  });

  it('ERC-20: transfer(to, amount) calldata to the token, warns on low balance', async () => {
    const h = harness();
    const out = await ok(h, 'build_transfer', {
      chainId: SEPOLIA,
      from: SWAPPER,
      token: 'USDC',
      amount: '20',
      to: OTHER,
    });
    const tx = out.steps[0].tx;
    expect(tx).toMatchObject({ to: SEPOLIA_USDC, value: '0' });
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data })).toEqual({
      functionName: 'transfer',
      args: [OTHER, 20_000_000n],
    });
    expect(out.warnings[0]).toMatch(/below the amount/);
  });

  it('refuses the zero address and zero amounts', async () => {
    const h = harness();
    expect(
      await fail(h, 'build_transfer', {
        chainId: SEPOLIA,
        from: SWAPPER,
        token: 'ETH',
        amount: '1',
        to: ETH,
      })
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await fail(h, 'build_transfer', {
        chainId: SEPOLIA,
        from: SWAPPER,
        token: 'ETH',
        amount: '0',
        to: OTHER,
      })
    ).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('build_lp_position', () => {
  it('narrow preset with a v4 batch permit → NEEDS_SIGNATURE → finalize → READY', async () => {
    const h = harness();
    seed(h);
    h.http.on('POST', `${LP}/lp/check_approval`, { body: approvalBody(true) });
    h.http.on('POST', `${LP}/lp/create`, { body: lpCreateResponse() });

    const first = await ok(h, 'build_lp_position', lpArgs);
    expect(first.status).toBe('NEEDS_SIGNATURE');
    expect(first.preSteps.map((s: { kind: string }) => s.kind)).toEqual(['APPROVAL']);
    // Proto-encoded permit normalised for viem: numeric chainId, bare field arrays, primary type.
    expect(first.signature.kind).toBe('V4_BATCH_PERMIT');
    expect(first.signature.typedData.domain.chainId).toBe(SEPOLIA);
    expect(first.signature.typedData.types.PermitBatch).toEqual(
      V4_BATCH_PERMIT_PROTO.types.PermitBatch.fields
    );
    expect(first.signature.typedData.primaryType).toBe('PermitBatch');
    // ±5% around tick -196300, snapped outward to tickSpacing 60.
    expect(first.summary.lp).toMatchObject({ tickLower: -196860, tickUpper: -195780 });
    expect(Number(first.summary.lp.expectedMinPrice)).toBeLessThan(
      Number(first.summary.lp.expectedMaxPrice)
    );
    const approvalReq = h.http.callsTo('/lp/check_approval')[0]!.body as {
      action: string;
      lpTokens: { tokenAddress: string }[];
    };
    expect(approvalReq.action).toBe('CREATE');
    expect(approvalReq.lpTokens.map((t) => t.tokenAddress)).toEqual([ETH, SEPOLIA_USDC]);
    expect(h.http.callsTo('/lp/create')).toHaveLength(0);

    const final = await ok(h, 'build_lp_position', {
      ...lpArgs,
      resumeToken: first.resumeToken,
      signature: SIG,
    });
    expect(final.status).toBe('READY');
    expect(final.steps).toEqual([
      expect.objectContaining({
        kind: 'LP_CREATE',
        tx: expect.objectContaining({ to: SEPOLIA_PM, from: SWAPPER, value: '1000000000000000' }),
      }),
    ]);
    expect(final.summary.lp).toMatchObject({
      adjustedMinPrice: '2780.112',
      adjustedMaxPrice: '3089.9876',
      amount1: { raw: '25120443' },
    });
    const createBody = h.http.callsTo('/lp/create')[0]!.body as Record<string, unknown>;
    expect(createBody).toMatchObject({
      walletAddress: SWAPPER,
      protocol: 'V4',
      chainId: SEPOLIA,
      existingPool: {
        token0Address: ETH,
        token1Address: SEPOLIA_USDC,
        poolReference: V4_ETH_USDC_POOL,
      },
      independentToken: { tokenAddress: ETH, amount: '1000000000000000' },
      tickBounds: { tickLower: -196860, tickUpper: -195780 },
      slippageTolerance: 0.5,
      nativeTokenBalance: '1000000000000000000',
      signature: SIG,
    });
    // The ORIGINAL proto-encoded permit is sent back unchanged, under `batchPermitData`.
    expect(createBody.batchPermitData).toEqual(V4_BATCH_PERMIT_PROTO);
  });

  it('without a permit → READY with approvals then LP_CREATE', async () => {
    const h = harness();
    seed(h);
    h.http.on('POST', `${LP}/lp/check_approval`, { body: approvalBody(false) });
    h.http.on('POST', `${LP}/lp/create`, { body: lpCreateResponse() });
    const out = await ok(h, 'build_lp_position', {
      ...lpArgs,
      range: { minPrice: '2800', maxPrice: '3100' },
    });
    expect(out.status).toBe('READY');
    expect(out.steps.map((s: { kind: string }) => s.kind)).toEqual(['APPROVAL', 'LP_CREATE']);
    const body = h.http.callsTo('/lp/create')[0]!.body as {
      tickBounds: { tickLower: number; tickUpper: number };
      batchPermitData?: unknown;
    };
    expect(Math.abs(body.tickBounds.tickLower % 60)).toBe(0);
    expect(Math.abs(body.tickBounds.tickUpper % 60)).toBe(0);
    expect(body.tickBounds.tickLower).toBeLessThan(TICK);
    expect(body.tickBounds.tickUpper).toBeGreaterThan(TICK);
    expect(body.batchPermitData).toBeUndefined();
  });

  it('refuses permissioned pools when the wallet needs KYC', async () => {
    const h = harness();
    seed(h);
    h.http.on('POST', `${LP}/lp/check_approval`, { body: approvalBody(false, true) });
    expect(await fail(h, 'build_lp_position', lpArgs)).toMatchObject({
      code: 'KYC_REQUIRED',
      retryable: false,
    });
  });

  it('validates pool identity and token order', async () => {
    const h = harness();
    seed(h);
    expect(
      await fail(h, 'build_lp_position', {
        ...lpArgs,
        pool: { ...lpArgs.pool, token0: 'USDC', token1: 'ETH' },
      })
    ).toMatchObject({
      code: 'INVALID_INPUT',
    });
    const unknown = `0x${'77'.repeat(32)}`;
    h.http.on('POST', `${LP}/lp/pool_info`, { body: { requestId: 'x', pools: [] } });
    expect(
      await fail(h, 'build_lp_position', {
        ...lpArgs,
        pool: { ...lpArgs.pool, poolReference: unknown },
      })
    ).toMatchObject({
      code: 'POOL_NOT_FOUND',
    });
  });
});

describe('build_lp_exit', () => {
  it('partial exit with claimFees → LP_CLAIM then LP_DECREASE', async () => {
    const h = harness();
    seed(h);
    h.http.on('POST', `${LP}/lp/claim_fees`, { body: lpClaimResponse() });
    h.http.on('POST', `${LP}/lp/decrease`, { body: lpDecreaseResponse() });
    const out = await ok(h, 'build_lp_exit', {
      chainId: SEPOLIA,
      owner: SWAPPER,
      protocol: 'V4',
      token0: 'ETH',
      token1: 'USDC',
      tokenId: '42',
      percent: 50,
      claimFees: true,
    });
    expect(out.status).toBe('READY');
    expect(out.steps.map((s: { kind: string }) => s.kind)).toEqual(['LP_CLAIM', 'LP_DECREASE']);
    expect(out.steps.every((s: { tx: { to: string } }) => s.tx.to === SEPOLIA_PM)).toBe(true);
    expect(h.http.callsTo('/lp/claim_fees')[0]!.body).toMatchObject({
      protocol: 'V4',
      walletAddress: SWAPPER,
      chainId: SEPOLIA,
      tokenId: '42',
    });
    expect(h.http.callsTo('/lp/decrease')[0]!.body).toMatchObject({
      nftTokenId: '42',
      liquidityPercentageToDecrease: 50,
      token0Address: ETH,
      token1Address: SEPOLIA_USDC,
    });
    expect(out.summary.lp).toMatchObject({
      percent: 50,
      tokenId: '42',
      amount1: { decimal: '12.5' },
    });
  });

  it('full exit has a single decrease (v4 collects fees on modify)', async () => {
    const h = harness();
    seed(h);
    h.http.on('POST', `${LP}/lp/decrease`, { body: lpDecreaseResponse() });
    const out = await ok(h, 'build_lp_exit', {
      chainId: SEPOLIA,
      owner: SWAPPER,
      protocol: 'V4',
      token0: 'ETH',
      token1: 'USDC',
      tokenId: '42',
      percent: 100,
      claimFees: true,
    });
    expect(out.steps.map((s: { kind: string }) => s.kind)).toEqual(['LP_DECREASE']);
    expect(out.warnings[0]).toMatch(/already collects/);
  });

  it('refuses positions that are not the owner’s or do not exist', async () => {
    const h = harness();
    seed(h);
    const args = {
      chainId: SEPOLIA,
      owner: OTHER,
      protocol: 'V4',
      token0: 'ETH',
      token1: 'USDC',
      tokenId: '42',
      percent: 10,
      claimFees: false,
    };
    expect(await fail(h, 'build_lp_exit', args)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await fail(h, 'build_lp_exit', { ...args, owner: SWAPPER, tokenId: '404' })
    ).toMatchObject({ code: 'POSITION_NOT_FOUND' });
  });
});

describe('build_rebalance', () => {
  it('returns READY exit steps plus next build_lp_position args from expected amounts', async () => {
    const h = harness();
    seed(h);
    h.http.on('POST', `${LP}/lp/decrease`, { body: lpDecreaseResponse() });
    const out = await ok(h, 'build_rebalance', {
      chainId: SEPOLIA,
      owner: SWAPPER,
      tokenId: '42',
      token0: 'ETH',
      token1: 'USDC',
      poolReference: V4_ETH_USDC_POOL,
      newRange: { preset: 'wide' },
    });
    expect(out.status).toBe('READY');
    expect(out.steps.map((s: { kind: string }) => s.kind)).toEqual(['LP_DECREASE']);
    expect(
      (h.http.callsTo('/lp/decrease')[0]!.body as { liquidityPercentageToDecrease: number })
        .liquidityPercentageToDecrease
    ).toBe(100);
    // Expected = decrease principal + uncollected fees (1 × L of token0).
    expect(out.next.expected.amount0.raw).toBe(
      (500_000_000_000_000n + 2_000_000_000_000n).toString()
    );
    expect(out.next.expected.amount1.raw).toBe('12500000');
    expect(out.next.tool).toBe('build_lp_position');
    expect(out.next.args).toMatchObject({
      chainId: SEPOLIA,
      owner: SWAPPER,
      range: { preset: 'wide' },
      slippagePct: 0.5,
    });
    expect([ETH, SEPOLIA_USDC]).toContain(out.next.args.independentToken.token);
    expect(BuildLpPositionInputSchema.safeParse(out.next.args).success).toBe(true);
  });

  it('fails for a missing position', async () => {
    const h = harness();
    seed(h);
    const err = await fail(h, 'build_rebalance', {
      chainId: SEPOLIA,
      owner: SWAPPER,
      tokenId: '9',
      token0: 'ETH',
      token1: 'USDC',
      poolReference: V4_ETH_USDC_POOL,
      newRange: { preset: 'medium' },
    });
    expect(err.code).toBe('POSITION_NOT_FOUND');
  });
});
