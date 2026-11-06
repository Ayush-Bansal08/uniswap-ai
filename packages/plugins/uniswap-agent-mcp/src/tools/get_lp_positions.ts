/**
 * get_lp_positions — v4 positions by tokenId: PositionManager (pool key, ticks, liquidity),
 * StateView (slot0, liquidity, fee growth) and v4-sdk math for amounts.
 */
import { getAddress } from 'viem';
import type { z } from 'zod';
import { amountOf, sumDecimals, usdValue, type Decimal } from '../amounts.js';
import { getChain } from '../chains.js';
import { requireReadableChain, type ToolDeps } from '../context.js';
import { isZeroHook } from '../hooks/permissions.js';
import { GetLpPositionsInputSchema, GetLpPositionsOutputSchema } from '../schemas.js';
import { priceForToken } from '../services/prices.js';
import {
  decodePositionInfo,
  poolIdOf,
  positionAmounts,
  positionSalt,
  priceAtTick,
  priceFromSqrt,
  sdkPool,
  uncollectedFees,
} from '../v4/math.js';
import { defineTool, short } from './define.js';

type Position = z.infer<typeof GetLpPositionsOutputSchema>['positions'][number];

async function readPosition(
  deps: ToolDeps,
  chainId: number,
  owner: string,
  tokenIdStr: string
): Promise<Position | null> {
  const chain = getChain(chainId);
  const reader = deps.reader(chainId);
  const tokenId = BigInt(tokenIdStr);
  const holder = await reader.ownerOf(chain.positionManager, tokenId);
  if (!holder) return null;
  const [{ poolKey, info }, liquidity] = await Promise.all([
    reader.getPoolAndPositionInfo(chain.positionManager, tokenId),
    reader.getPositionLiquidity(chain.positionManager, tokenId),
  ]);
  if (poolKey.tickSpacing === 0) return null;
  const { tickLower, tickUpper } = decodePositionInfo(info);
  const [token0, token1] = await Promise.all([
    deps.tokens.resolve(chainId, poolKey.currency0),
    deps.tokens.resolve(chainId, poolKey.currency1),
  ]);
  const poolId = poolIdOf(chainId, token0, token1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks);
  const [slot0, poolLiquidity] = await Promise.all([
    reader.getSlot0(chain.stateView, poolId),
    reader.getLiquidity(chain.stateView, poolId),
  ]);
  const pool = sdkPool(
    chainId,
    { token0, token1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks },
    {
      sqrtPriceX96: slot0.sqrtPriceX96,
      tick: slot0.tick,
      liquidity: poolLiquidity,
    }
  );
  const { amount0, amount1 } = positionAmounts(pool, liquidity, tickLower, tickUpper);

  let fees0: bigint | null = null;
  let fees1: bigint | null = null;
  try {
    const fee = await reader.getPositionFeeState(chain.stateView, {
      poolId,
      owner: chain.positionManager,
      tickLower,
      tickUpper,
      salt: positionSalt(tokenId),
    });
    fees0 = uncollectedFees(fee.liquidity, fee.feeGrowthInside0X128, fee.feeGrowthInside0LastX128);
    fees1 = uncollectedFees(fee.liquidity, fee.feeGrowthInside1X128, fee.feeGrowthInside1LastX128);
  } catch (err) {
    deps.log.warn('fee growth read failed', {
      tokenId: tokenIdStr,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const [p0, p1] = await Promise.all([
    priceForToken(deps, chainId, token0.address),
    priceForToken(deps, chainId, token1.address),
  ]);
  const a0 = amountOf(amount0 + (fees0 ?? 0n), token0.decimals).decimal;
  const a1 = amountOf(amount1 + (fees1 ?? 0n), token1.decimals).decimal;
  const valueUsd =
    p0 !== null && p1 !== null ? sumDecimals([usdValue(a0, p0), usdValue(a1, p1)]) : null;
  const sig = (d: Decimal) => d.toSignificantDigits(10).toFixed();

  return {
    tokenId: tokenIdStr,
    owner: holder,
    ownerMatches: holder === getAddress(owner),
    poolId,
    poolKey,
    hookAddress: isZeroHook(poolKey.hooks) ? null : poolKey.hooks,
    token0,
    token1,
    tickLower,
    tickUpper,
    currentTick: slot0.tick,
    inRange: slot0.tick >= tickLower && slot0.tick < tickUpper,
    liquidity: liquidity.toString(),
    poolLiquidity: poolLiquidity.toString(),
    amount0: amountOf(amount0, token0.decimals),
    amount1: amountOf(amount1, token1.decimals),
    uncollectedFees0: fees0 !== null ? amountOf(fees0, token0.decimals) : null,
    uncollectedFees1: fees1 !== null ? amountOf(fees1, token1.decimals) : null,
    priceLower: sig(priceAtTick(tickLower, token0.decimals, token1.decimals)),
    priceUpper: sig(priceAtTick(tickUpper, token0.decimals, token1.decimals)),
    priceCurrent: sig(priceFromSqrt(slot0.sqrtPriceX96, token0.decimals, token1.decimals)),
    valueUsd,
  };
}

export const getLpPositionsTool = defineTool({
  name: 'get_lp_positions',
  title: 'v4 LP positions',
  description:
    'Read Uniswap v4 LP positions by tokenId from the PositionManager and StateView contracts: pool key, hook, tick range, current tick, in-range flag, liquidity, token amounts (v4-sdk math), uncollected fees (from fee growth) and USD value (mainnet reference prices). Pass the tokenIds you know; positions not owned by `owner` are returned with ownerMatches=false. Read-only.',
  kind: 'read',
  input: GetLpPositionsInputSchema,
  output: GetLpPositionsOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    const ids = [...new Set(args.tokenIds)];
    const results = await Promise.all(
      ids.map((id) => readPosition(deps, args.chainId, args.owner, id))
    );
    const positions = results.filter((p): p is Position => p !== null);
    const values = positions.map((p) => p.valueUsd);
    const blockNumber = await deps
      .reader(args.chainId)
      .getBlockNumber()
      .then(String)
      .catch(() => null);
    return {
      chainId: args.chainId,
      owner: getAddress(args.owner),
      positions,
      notFound: ids.filter((_, i) => results[i] === null),
      totalValueUsd:
        values.length && values.every((v) => v !== null) ? sumDecimals(values as string[]) : null,
      blockNumber,
      asOf: new Date(deps.now()).toISOString(),
    };
  },
  summarize(o) {
    const lines = o.positions.map(
      (p) =>
        `#${p.tokenId} ${p.token0.symbol}/${p.token1.symbol} ${
          p.inRange ? 'in range' : 'OUT OF RANGE'
        } (${p.amount0.decimal} ${p.token0.symbol} + ${p.amount1.decimal} ${p.token1.symbol}${
          p.valueUsd ? `, $${p.valueUsd}` : ''
        })`
    );
    return `${o.positions.length} position(s) for ${short(o.owner)} on chain ${o.chainId}${
      lines.length ? `: ${lines.join('; ')}` : ''
    }${o.notFound.length ? `; not found: ${o.notFound.join(', ')}` : ''}.`;
  },
});
