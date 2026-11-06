/**
 * build_rebalance — exit a v4 position fully (fees included) and plan the re-entry.
 * Returns READY exit steps plus `next: { tool: 'build_lp_position', args }` computed from the
 * expected amounts (principal from /lp/decrease + uncollected fees from StateView). The caller
 * executes the exit, then calls build_lp_position with its ACTUAL balances. A different
 * `poolReference` moves the liquidity to another pool of the same pair.
 */
import { getAddress } from 'viem';
import { amountOf, fromRaw } from '../amounts.js';
import { getChain } from '../chains.js';
import { requireExecutionChain } from '../context.js';
import { invalidInput } from '../errors.js';
import { BuildRebalanceInputSchema, BuildRebalanceOutputSchema } from '../schemas.js';
import { assertPositionOwner, exitSteps, loadPool, resolvePair } from '../services/lp.js';
import {
  decodePositionInfo,
  limitingSide,
  poolIdOf,
  positionSalt,
  rangeToTicks,
  uncollectedFees,
} from '../v4/math.js';
import { defineTool } from './define.js';

export const buildRebalanceTool = defineTool({
  name: 'build_rebalance',
  title: 'Build an unsigned LP rebalance',
  description:
    'Rebalance a Uniswap v4 position: returns READY unsigned steps that remove 100% of the position (accrued fees included) via the LP API, plus `next` = the build_lp_position arguments for the new range (or a different poolReference of the same pair to move pools), computed from the expected exit amounts. Execute the exit first, then call build_lp_position with the actual balances. Never signs or broadcasts.',
  kind: 'build',
  input: BuildRebalanceInputSchema,
  output: BuildRebalanceOutputSchema,
  async handler(args, deps) {
    requireExecutionChain(deps, args.chainId);
    const chainId = args.chainId;
    const chain = getChain(chainId);
    const owner = getAddress(args.owner);
    const { token0, token1 } = await resolvePair(deps, chainId, args.token0, args.token1);
    await assertPositionOwner(deps, chainId, args.tokenId, owner);

    // Uncollected fees of the current position (collected by the 100% decrease).
    const reader = deps.reader(chainId);
    const tokenId = BigInt(args.tokenId);
    const { poolKey, info } = await reader.getPoolAndPositionInfo(chain.positionManager, tokenId);
    if (
      poolKey.currency0.toLowerCase() !== token0.address.toLowerCase() ||
      poolKey.currency1.toLowerCase() !== token1.address.toLowerCase()
    ) {
      throw invalidInput(
        `Position #${args.tokenId} is ${poolKey.currency0}/${poolKey.currency1}, not ${token0.symbol}/${token1.symbol}`
      );
    }
    const { tickLower: oldLower, tickUpper: oldUpper } = decodePositionInfo(info);
    let fees0 = 0n;
    let fees1 = 0n;
    try {
      const fee = await reader.getPositionFeeState(chain.stateView, {
        poolId: poolIdOf(chainId, token0, token1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks),
        owner: chain.positionManager,
        tickLower: oldLower,
        tickUpper: oldUpper,
        salt: positionSalt(tokenId),
      });
      fees0 = uncollectedFees(
        fee.liquidity,
        fee.feeGrowthInside0X128,
        fee.feeGrowthInside0LastX128
      );
      fees1 = uncollectedFees(
        fee.liquidity,
        fee.feeGrowthInside1X128,
        fee.feeGrowthInside1LastX128
      );
    } catch {
      /* fees unknown → plan with principal only */
    }

    const exit = await exitSteps(deps, {
      chainId,
      owner,
      token0,
      token1,
      tokenId: args.tokenId,
      percent: 100,
      claimFees: false,
      ...(args.slippagePct !== undefined ? { slippagePct: args.slippagePct } : {}),
    });
    const expected0 = BigInt(exit.amount0) + fees0;
    const expected1 = BigInt(exit.amount1) + fees1;
    if (expected0 === 0n && expected1 === 0n)
      throw invalidInput(`Position #${args.tokenId} has no liquidity to rebalance`);

    const target = await loadPool(deps, chainId, args.poolReference, token0, token1);
    const { tickLower, tickUpper } = rangeToTicks({
      range: args.newRange,
      currentTick: target.tick,
      tickSpacing: target.key.tickSpacing,
      decimals0: token0.decimals,
      decimals1: token1.decimals,
    });
    const limit = limitingSide(target.sdk, tickLower, tickUpper, expected0, expected1);
    const independent = limit.side === 0 ? token0 : token1;
    const fallback =
      limit.amount === 0n
        ? limit.side === 0
          ? { t: token1, a: expected1 }
          : { t: token0, a: expected0 }
        : null;

    return {
      status: 'READY' as const,
      steps: exit.steps,
      summary: {
        poolRef: target.poolId,
        lp: {
          token0,
          token1,
          amount0: amountOf(expected0, token0.decimals),
          amount1: amountOf(expected1, token1.decimals),
          tokenId: args.tokenId,
          percent: 100,
          tickLower,
          tickUpper,
        },
      },
      next: {
        tool: 'build_lp_position' as const,
        args: {
          chainId,
          owner,
          pool: { poolReference: target.poolId, token0: token0.address, token1: token1.address },
          independentToken: fallback
            ? { token: fallback.t.address, amount: fromRaw(fallback.a, fallback.t.decimals) }
            : { token: independent.address, amount: fromRaw(limit.amount, independent.decimals) },
          range: args.newRange,
          slippagePct: args.slippagePct ?? 0.5,
        },
        expected: {
          amount0: amountOf(expected0, token0.decimals),
          amount1: amountOf(expected1, token1.decimals),
        },
      },
      warnings: [
        'Execute the exit steps first, then call build_lp_position with your actual balances (amounts here are estimates).',
        ...(target.poolId !==
        poolIdOf(chainId, token0, token1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks)
          ? [`Moving liquidity to a different pool (${target.poolId}).`]
          : []),
      ],
    };
  },
  summarize(o) {
    const lp = o.summary.lp;
    return `Rebalance #${lp?.tokenId}: ${o.steps?.length ?? 0} unsigned exit tx, expect ≈ ${
      o.next.expected.amount0.decimal
    } ${lp?.token0.symbol} + ${o.next.expected.amount1.decimal} ${
      lp?.token1.symbol
    }; next: build_lp_position in ${o.next.args.pool.poolReference.slice(0, 10)}… with ${
      o.next.args.independentToken.amount
    } of ${
      o.next.args.independentToken.token === lp?.token0.address
        ? lp?.token0.symbol
        : lp?.token1.symbol
    }.`;
  },
});
