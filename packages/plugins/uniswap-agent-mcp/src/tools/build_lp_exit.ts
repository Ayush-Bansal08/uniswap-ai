/**
 * build_lp_exit — UNSIGNED partial/full exit of a v4 position via the LP API:
 * /lp/claim_fees (when percent < 100 and claimFees) then /lp/decrease. In v4 any liquidity
 * modification also collects accrued fees, so a 100% exit already includes them.
 */
import { getAddress } from 'viem';
import { amountOf } from '../amounts.js';
import { requireExecutionChain } from '../context.js';
import { BuildLpExitInputSchema, BuildResultSchema, type BuildResultObject } from '../schemas.js';
import { assertPositionOwner, exitSteps, resolvePair } from '../services/lp.js';
import { defineTool } from './define.js';

export const buildLpExitTool = defineTool({
  name: 'build_lp_exit',
  title: 'Build an unsigned LP exit',
  description:
    'Build UNSIGNED transactions to withdraw percent (1–100) of a Uniswap v4 position via the LP API (/lp/decrease, plus /lp/claim_fees first when percent < 100 and claimFees is true). Checks the position belongs to owner. Never signs or broadcasts. Returns READY steps (LP_CLAIM?, LP_DECREASE) with the expected token amounts.',
  kind: 'build',
  input: BuildLpExitInputSchema,
  output: BuildResultSchema,
  async handler(args, deps): Promise<BuildResultObject> {
    requireExecutionChain(deps, args.chainId);
    const owner = getAddress(args.owner);
    const { token0, token1 } = await resolvePair(deps, args.chainId, args.token0, args.token1);
    await assertPositionOwner(deps, args.chainId, args.tokenId, owner);
    const exit = await exitSteps(deps, {
      chainId: args.chainId,
      owner,
      token0,
      token1,
      tokenId: args.tokenId,
      percent: args.percent,
      claimFees: args.claimFees,
      ...(args.slippagePct !== undefined ? { slippagePct: args.slippagePct } : {}),
    });
    const warnings =
      args.percent === 100 && args.claimFees
        ? ['A 100% v4 decrease already collects accrued fees; no separate claim step was added.']
        : [];
    return {
      status: 'READY',
      steps: exit.steps,
      summary: {
        lp: {
          token0,
          token1,
          amount0: amountOf(exit.amount0, token0.decimals),
          amount1: amountOf(exit.amount1, token1.decimals),
          tokenId: args.tokenId,
          percent: args.percent,
        },
      },
      ...(warnings.length ? { warnings } : {}),
    };
  },
  summarize(o) {
    const lp = o.summary.lp;
    return `Exit ${lp?.percent}% of position #${lp?.tokenId}: ${
      o.steps?.length ?? 0
    } unsigned tx (${o.steps?.map((s) => s.kind).join(' → ')}), receive ≈ ${lp?.amount0?.decimal} ${
      lp?.token0.symbol
    } + ${lp?.amount1?.decimal} ${lp?.token1.symbol}.`;
  },
});
