/**
 * Uniswap v4 math, using the official SDKs (v4-sdk-integration skill: "ALWAYS use
 * Pool.getPoolId()"; position amounts via `Position`). Prices are token1 per token0 in human
 * units unless stated otherwise.
 */
import type { Currency } from '@uniswap/sdk-core';
import { getAddress, type Address, type Hex } from 'viem';
import { Decimal } from '../amounts.js';
import { NATIVE_ADDRESS } from '../chains.js';
import { invalidInput, McpToolError } from '../errors.js';
import type { TokenInfo } from '../schemas.js';
import { core, v3, v4 } from './sdk.js';

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export function toCurrency(chainId: number, token: TokenInfo): Currency {
  if (token.isNative || token.address.toLowerCase() === NATIVE_ADDRESS) {
    return core.Ether.onChain(chainId);
  }
  return new core.Token(chainId, getAddress(token.address), token.decimals, token.symbol);
}

export function sortTokens(a: TokenInfo, b: TokenInfo): [TokenInfo, TokenInfo] {
  return BigInt(a.address) < BigInt(b.address) ? [a, b] : [b, a];
}

/** v4 poolId = keccak256(abi.encode(PoolKey)), computed by the SDK. */
export function poolIdOf(
  chainId: number,
  token0: TokenInfo,
  token1: TokenInfo,
  fee: number,
  tickSpacing: number,
  hooks: Address
): Hex {
  return v4.Pool.getPoolId(
    toCurrency(chainId, token0),
    toCurrency(chainId, token1),
    fee,
    tickSpacing,
    hooks
  ) as Hex;
}

/** Decode a v4-periphery PositionInfo (bits 8..31 tickLower, 32..55 tickUpper, 0..7 hasSubscriber). */
export function decodePositionInfo(info: bigint): {
  tickLower: number;
  tickUpper: number;
  hasSubscriber: boolean;
  poolIdPrefix: Hex;
} {
  const int24 = (v: bigint) => {
    const n = Number(v & 0xffffffn);
    return n >= 0x800000 ? n - 0x1000000 : n;
  };
  return {
    hasSubscriber: (info & 0xffn) !== 0n,
    tickLower: int24(info >> 8n),
    tickUpper: int24(info >> 32n),
    poolIdPrefix: `0x${(info >> 56n).toString(16).padStart(50, '0')}` as Hex,
  };
}

/** Human price (token1 per token0) at a tick. */
export function priceAtTick(tick: number, decimals0: number, decimals1: number): Decimal {
  return new Decimal('1.0001').pow(tick).mul(new Decimal(10).pow(decimals0 - decimals1));
}

/** Human price (token1 per token0) from sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): Decimal {
  const ratio = new Decimal(sqrtPriceX96.toString()).div(new Decimal(2).pow(96)).pow(2);
  return ratio.mul(new Decimal(10).pow(decimals0 - decimals1));
}

/** Tick for a human price (token1 per token0), not yet snapped to the spacing. */
export function tickAtPrice(price: Decimal, decimals0: number, decimals1: number): number {
  if (price.lte(0)) throw invalidInput('Price must be greater than zero');
  const raw = price.div(new Decimal(10).pow(decimals0 - decimals1));
  return Math.floor(Decimal.ln(raw).div(Decimal.ln('1.0001')).toNumber());
}

export function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}
export function ceilToSpacing(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

function clampUsable(tick: number, spacing: number): number {
  const min = ceilToSpacing(MIN_TICK, spacing);
  const max = floorToSpacing(MAX_TICK, spacing);
  return Math.min(Math.max(tick, min), max);
}

export const RANGE_PRESET_PCT = Object.freeze({ narrow: 5, medium: 15, wide: 40 });

/**
 * Tick bounds for a range: a preset (± pct around the current price) or explicit human
 * prices. Lower bound floors and upper bound ceils to the tick spacing, so the range always
 * contains the requested one.
 */
export function rangeToTicks(args: {
  range: { preset: 'narrow' | 'medium' | 'wide' } | { minPrice: string; maxPrice: string };
  currentTick: number;
  tickSpacing: number;
  decimals0: number;
  decimals1: number;
}): { tickLower: number; tickUpper: number } {
  const { range, currentTick, tickSpacing, decimals0, decimals1 } = args;
  let lower: number;
  let upper: number;
  if ('preset' in range) {
    const pct = RANGE_PRESET_PCT[range.preset] / 100;
    const ln = Decimal.ln('1.0001');
    lower =
      currentTick +
      Math.floor(
        Decimal.ln(1 - pct)
          .div(ln)
          .toNumber()
      );
    upper =
      currentTick +
      Math.ceil(
        Decimal.ln(1 + pct)
          .div(ln)
          .toNumber()
      );
  } else {
    const min = new Decimal(range.minPrice);
    const max = new Decimal(range.maxPrice);
    if (min.lte(0) || max.lte(min)) {
      throw invalidInput('range.minPrice must be > 0 and below range.maxPrice');
    }
    lower = tickAtPrice(min, decimals0, decimals1);
    upper = tickAtPrice(max, decimals0, decimals1) + 1;
  }
  const tickLower = clampUsable(floorToSpacing(lower, tickSpacing), tickSpacing);
  let tickUpper = clampUsable(ceilToSpacing(upper, tickSpacing), tickSpacing);
  if (tickUpper <= tickLower) tickUpper = tickLower + tickSpacing;
  if (tickUpper > floorToSpacing(MAX_TICK, tickSpacing)) {
    throw invalidInput('Range is outside the valid tick range');
  }
  return { tickLower, tickUpper };
}

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export function sdkPool(
  chainId: number,
  key: { token0: TokenInfo; token1: TokenInfo; fee: number; tickSpacing: number; hooks: Address },
  state: PoolState
) {
  try {
    return new v4.Pool(
      toCurrency(chainId, key.token0),
      toCurrency(chainId, key.token1),
      key.fee,
      key.tickSpacing,
      key.hooks,
      state.sqrtPriceX96.toString(),
      state.liquidity.toString(),
      state.tick
    );
  } catch (err) {
    throw new McpToolError(
      'INTERNAL',
      `Could not model the pool with the v4 SDK: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { retryable: false }
    );
  }
}

/** Token amounts held by a position at the current price (v4-sdk `Position`). */
export function positionAmounts(
  pool: ReturnType<typeof sdkPool>,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number
): { amount0: bigint; amount1: bigint } {
  const position = new v4.Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });
  return {
    amount0: BigInt(position.amount0.quotient.toString()),
    amount1: BigInt(position.amount1.quotient.toString()),
  };
}

/** Amounts needed for a position given one side (independent token), from the v4 SDK. */
export function amountsForIndependent(
  pool: ReturnType<typeof sdkPool>,
  tickLower: number,
  tickUpper: number,
  side: 0 | 1,
  amount: bigint
): { amount0: bigint; amount1: bigint } {
  const position =
    side === 0
      ? v4.Position.fromAmount0({
          pool,
          tickLower,
          tickUpper,
          amount0: amount.toString(),
          useFullPrecision: true,
        })
      : v4.Position.fromAmount1({ pool, tickLower, tickUpper, amount1: amount.toString() });
  const { amount0, amount1 } = position.mintAmounts;
  return { amount0: BigInt(amount0.toString()), amount1: BigInt(amount1.toString()) };
}

/**
 * Given the amounts available for a new range, which side limits liquidity? Returns the
 * limiting side and its amount (used as `independentToken` for build_lp_position).
 */
export function limitingSide(
  pool: ReturnType<typeof sdkPool>,
  tickLower: number,
  tickUpper: number,
  available0: bigint,
  available1: bigint
): { side: 0 | 1; amount: bigint } {
  if (pool.tickCurrent < tickLower) return { side: 0, amount: available0 };
  if (pool.tickCurrent >= tickUpper) return { side: 1, amount: available1 };
  const position = v4.Position.fromAmounts({
    pool,
    tickLower,
    tickUpper,
    amount0: available0.toString(),
    amount1: available1.toString(),
    useFullPrecision: true,
  });
  const need0 = BigInt(position.mintAmounts.amount0.toString());
  const need1 = BigInt(position.mintAmounts.amount1.toString());
  // The side whose full balance is (≈) consumed is the limiting one.
  const slack0 = available0 - need0;
  const slack1 = available1 - need1;
  const rel0 = available0 === 0n ? 0 : Number((slack0 * 1_000_000n) / available0);
  const rel1 = available1 === 0n ? 0 : Number((slack1 * 1_000_000n) / available1);
  return rel0 <= rel1 ? { side: 0, amount: available0 } : { side: 1, amount: available1 };
}

const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Uncollected fees = (feeGrowthInside − feeGrowthInsideLast) × liquidity / 2^128 (mod 2^256). */
export function uncollectedFees(liquidity: bigint, inside: bigint, insideLast: bigint): bigint {
  const delta = (inside - insideLast) & MAX_UINT256;
  return (delta * liquidity) / Q128;
}

/** sqrtPriceX96 at a tick (exact TickMath, for consistent test fixtures and range checks). */
export function sqrtPriceAtTick(tick: number): bigint {
  return BigInt(v3.TickMath.getSqrtRatioAtTick(tick).toString());
}

/** Salt PositionManager uses for its PoolManager positions: bytes32(tokenId). */
export function positionSalt(tokenId: bigint): Hex {
  return `0x${tokenId.toString(16).padStart(64, '0')}` as Hex;
}
