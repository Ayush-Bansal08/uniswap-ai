/**
 * build_lp_position — UNSIGNED v4 position in an EXISTING pool via the LP API, following the
 * lp-integration skill:
 *   1. POST /lp/check_approval (action CREATE)  → approval txs = preSteps; KYC warnings refuse
 *   2. v4BatchPermitData present → NEEDS_SIGNATURE (typed data normalised for viem; the original
 *      permit object travels in the resumeToken and is sent back unchanged)
 *   3. POST /lp/create with `batchPermitData` + `signature` (or neither) → READY
 * Range: preset narrow ±5% / medium ±15% / wide ±40% around the current price, or explicit
 * min/max prices (token1 per token0). We compute tick bounds snapped to the pool's tick
 * spacing and send `tickBounds`; the API returns adjustedMinPrice/adjustedMaxPrice.
 */
import { getAddress } from 'viem';
import { amountOf, toRaw } from '../amounts.js';
import { getChain } from '../chains.js';
import type { CreatePositionRequest, Permit } from '../clients/lpApi.js';
import { requireExecutionChain } from '../context.js';
import { invalidInput, McpToolError } from '../errors.js';
import {
  BuildLpPositionInputSchema,
  BuildResultSchema,
  type BuildResultObject,
  type BuildSummary,
  type TxStep,
} from '../schemas.js';
import { loadPool, resolvePair } from '../services/lp.js';
import { normalizeSlippage } from '../services/quote.js';
import { normalizePermit } from '../services/typedData.js';
import { validateTx } from '../tx.js';
import { amountsForIndependent, priceAtTick, rangeToTicks } from '../v4/math.js';
import { defineTool } from './define.js';

/** LP tx deadline (seconds). Transactions are time-sensitive (skill note 4). */
const DEADLINE_SECONDS = 20 * 60;

interface LpResume {
  createBody: CreatePositionRequest;
  batchPermitData: Permit;
  summary: BuildSummary;
}

function withSlippage(amount: bigint, pct: number): bigint {
  return (amount * BigInt(10_000 + Math.round(pct * 100)) + 9_999n) / 10_000n;
}

export const buildLpPositionTool = defineTool({
  name: 'build_lp_position',
  title: 'Build an unsigned v4 LP position',
  description:
    'Build UNSIGNED transactions to open a Uniswap v4 liquidity position in an EXISTING pool via the LP API (/lp/check_approval → optional v4 batch permit → /lp/create). Never signs or broadcasts. Give the pool (poolReference = v4 poolId, token0/token1 in currency order), one independent token amount (the API computes the other), and a range: preset narrow (±5%) | medium (±15%) | wide (±40%) around the current price, or {minPrice, maxPrice} as token1 per token0. Returns READY steps (approvals, then LP_CREATE) or NEEDS_SIGNATURE (approval preSteps + EIP-712 PermitBatch + resumeToken valid 120 s; call again with the same args + resumeToken + signature).',
  kind: 'build',
  input: BuildLpPositionInputSchema,
  output: BuildResultSchema,
  async handler(args, deps): Promise<BuildResultObject> {
    requireExecutionChain(deps, args.chainId);
    const chainId = args.chainId;
    const chain = getChain(chainId);
    const owner = getAddress(args.owner);
    const createExpect = { chainId, from: owner, allowedTo: [chain.positionManager] };

    if (args.resumeToken || args.signature) {
      if (!args.resumeToken || !args.signature)
        throw invalidInput('resumeToken and signature must be sent together');
      const data = deps.resume.verify<LpResume>('build_lp_position', args, args.resumeToken);
      // /lp/create uses `batchPermitData` (lp-integration "Field-name quirks"); send the original object.
      const created = await deps.lp.create({
        ...data.createBody,
        batchPermitData: data.batchPermitData,
        signature: args.signature,
      });
      const step = validateTx(
        'LP_CREATE',
        'Create Uniswap v4 position',
        created.create,
        createExpect
      );
      return { status: 'READY', steps: [step], summary: lpSummary(data.summary, created) };
    }

    const { token0, token1 } = await resolvePair(deps, chainId, args.pool.token0, args.pool.token1);
    const independent = await deps.tokens.resolve(chainId, args.independentToken.token);
    const side: 0 | 1 =
      independent.address === token0.address
        ? 0
        : independent.address === token1.address
        ? 1
        : (() => {
            throw invalidInput('independentToken must be token0 or token1 of the pool');
          })();
    const independentRaw = toRaw(
      args.independentToken.amount,
      independent.decimals,
      'independentToken.amount'
    );
    if (independentRaw === 0n)
      throw invalidInput('independentToken.amount must be greater than zero');

    const pool = await loadPool(deps, chainId, args.pool.poolReference, token0, token1);
    const { tickLower, tickUpper } = rangeToTicks({
      range: args.range,
      currentTick: pool.tick,
      tickSpacing: pool.key.tickSpacing,
      decimals0: token0.decimals,
      decimals1: token1.decimals,
    });
    let expected: { amount0: bigint; amount1: bigint };
    try {
      expected = amountsForIndependent(pool.sdk, tickLower, tickUpper, side, independentRaw);
    } catch {
      throw invalidInput(
        `With the price ${pool.tick < tickLower ? 'below' : 'above'} this range only ${
          side === 0 ? token1.symbol : token0.symbol
        } can be deposited; use it as independentToken or move the range.`
      );
    }

    const lpTokens = [
      {
        tokenAddress: token0.address,
        amount: withSlippage(expected.amount0, args.slippagePct).toString(),
      },
      {
        tokenAddress: token1.address,
        amount: withSlippage(expected.amount1, args.slippagePct).toString(),
      },
    ].filter((t) => t.amount !== '0');
    const approval = await deps.lp.checkApproval({
      walletAddress: owner,
      protocol: 'V4',
      chainId: chainId as never,
      lpTokens,
      action: 'CREATE',
    });
    if (approval.kycRequiredWarnings?.length) {
      throw new McpToolError(
        'KYC_REQUIRED',
        'This pool contains a permissioned token and the wallet is not allowlisted',
        {
          retryable: false,
          details: { kycUrls: approval.kycRequiredWarnings.map((w) => w.kycUrl) },
        }
      );
    }
    const approvalExpect = {
      chainId,
      from: owner,
      allowedTo: [token0.address, token1.address, chain.permit2],
    };
    const preSteps: TxStep[] = (approval.transactions ?? []).map((t) =>
      validateTx(
        'APPROVAL',
        t.cancelApproval
          ? 'Reset a token allowance (required before re-approval)'
          : 'Approve token for the v4 PositionManager (via Permit2)',
        t.transaction,
        approvalExpect
      )
    );

    const nativeBalance =
      token0.isNative || token1.isNative
        ? (await deps.reader(chainId).getBalance(owner)).toString()
        : undefined;
    const createBody: CreatePositionRequest = {
      walletAddress: owner,
      chainId: chainId as never,
      protocol: 'V4',
      existingPool: {
        token0Address: token0.address,
        token1Address: token1.address,
        poolReference: pool.poolId,
      },
      independentToken: { tokenAddress: independent.address, amount: independentRaw.toString() },
      tickBounds: { tickLower, tickUpper },
      slippageTolerance: normalizeSlippage(args.slippagePct),
      deadline: Math.floor(deps.now() / 1000) + DEADLINE_SECONDS,
      simulateTransaction: false,
      ...(nativeBalance ? { nativeTokenBalance: nativeBalance } : {}),
    };
    const sig = (t: number) =>
      priceAtTick(t, token0.decimals, token1.decimals).toSignificantDigits(10).toFixed();
    const summary: BuildSummary = {
      poolRef: pool.poolId,
      ...(pool.key.hooks !== '0x0000000000000000000000000000000000000000'
        ? { hookAddress: pool.key.hooks }
        : {}),
      lp: {
        token0,
        token1,
        amount0: amountOf(expected.amount0, token0.decimals),
        amount1: amountOf(expected.amount1, token1.decimals),
        tickLower,
        tickUpper,
        expectedMinPrice: sig(tickLower),
        expectedMaxPrice: sig(tickUpper),
      },
    };

    const permit = approval.v4BatchPermitData;
    if (permit && typeof permit === 'object' && Object.keys(permit).length > 0) {
      const signature = normalizePermit('V4_BATCH_PERMIT', permit, chainId);
      const { token, expiresAt } = deps.resume.issue<LpResume>('build_lp_position', args, {
        createBody,
        batchPermitData: permit,
        summary,
      });
      return {
        status: 'NEEDS_SIGNATURE',
        preSteps,
        signature,
        resumeToken: token,
        expiresAt,
        summary,
      };
    }

    const created = await deps.lp.create(createBody);
    const step = validateTx(
      'LP_CREATE',
      `Create ${token0.symbol}/${token1.symbol} v4 position`,
      created.create,
      createExpect
    );
    return { status: 'READY', steps: [...preSteps, step], summary: lpSummary(summary, created) };
  },
  summarize(o) {
    const lp = o.summary.lp;
    const pair = lp ? `${lp.token0.symbol}/${lp.token1.symbol}` : 'v4';
    const range = lp?.adjustedMinPrice
      ? `${lp.adjustedMinPrice}–${lp.adjustedMaxPrice}`
      : lp?.expectedMinPrice
      ? `${lp.expectedMinPrice}–${lp.expectedMaxPrice}`
      : '?';
    if (o.status === 'NEEDS_SIGNATURE') {
      return `${pair} position (range ${range} ${lp?.token1.symbol ?? ''}/${
        lp?.token0.symbol ?? ''
      }) needs a v4 batch-permit signature after ${
        o.preSteps?.length ?? 0
      } approval tx; call again with resumeToken + signature before ${o.expiresAt}.`;
    }
    return `${pair} position ready: ${o.steps?.length ?? 0} unsigned tx (${o.steps
      ?.map((s) => s.kind)
      .join(' → ')}), deposit ≈ ${lp?.amount0?.decimal ?? '?'} ${lp?.token0.symbol ?? ''} + ${
      lp?.amount1?.decimal ?? '?'
    } ${lp?.token1.symbol ?? ''}, range ${range}.`;
  },
});

function lpSummary(
  base: BuildSummary,
  created: {
    token0: { amount: string };
    token1: { amount: string };
    tickLower: number;
    tickUpper: number;
    adjustedMinPrice: string;
    adjustedMaxPrice: string;
  }
): BuildSummary {
  if (!base.lp) return base;
  return {
    ...base,
    lp: {
      ...base.lp,
      amount0: amountOf(created.token0.amount, base.lp.token0.decimals),
      amount1: amountOf(created.token1.amount, base.lp.token1.decimals),
      tickLower: created.tickLower,
      tickUpper: created.tickUpper,
      adjustedMinPrice: created.adjustedMinPrice,
      adjustedMaxPrice: created.adjustedMaxPrice,
    },
  };
}
