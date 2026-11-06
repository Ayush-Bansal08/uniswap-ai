/**
 * Decode Uniswap v4 hook permissions from the hook address.
 *
 * The PoolManager derives the permission bitmap from the low 14 bits of the hook's address
 * (Security Framework §1 "Permission encoding & salt grinding pitfalls"). Flag names and bit
 * positions follow v4-core `Hooks.sol`: BEFORE_INITIALIZE_FLAG = 1 << 13 … AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 0
 * (the v4-security-foundations skill calls BEFORE_SWAP_RETURNS_DELTA "bit 3").
 */
import type { HookPermissionFlag, HookPermissions } from '../schemas.js';
import { HOOK_PERMISSION_FLAGS } from '../schemas.js';

export const HOOK_FLAG_BITS: Readonly<Record<HookPermissionFlag, number>> = Object.freeze({
  beforeInitialize: 13,
  afterInitialize: 12,
  beforeAddLiquidity: 11,
  afterAddLiquidity: 10,
  beforeRemoveLiquidity: 9,
  afterRemoveLiquidity: 8,
  beforeSwap: 7,
  afterSwap: 6,
  beforeDonate: 5,
  afterDonate: 4,
  beforeSwapReturnDelta: 3,
  afterSwapReturnDelta: 2,
  afterAddLiquidityReturnDelta: 1,
  afterRemoveLiquidityReturnDelta: 0,
});

export const ALL_HOOK_MASK = (1 << 14) - 1;

/** v4-security-foundations skill, "Permission Flags Risk Matrix". */
export const PERMISSION_RISK: Readonly<
  Record<HookPermissionFlag, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>
> = Object.freeze({
  beforeInitialize: 'LOW',
  afterInitialize: 'LOW',
  beforeAddLiquidity: 'MEDIUM',
  afterAddLiquidity: 'LOW',
  beforeRemoveLiquidity: 'HIGH',
  afterRemoveLiquidity: 'LOW',
  beforeSwap: 'HIGH',
  afterSwap: 'MEDIUM',
  beforeDonate: 'LOW',
  afterDonate: 'LOW',
  beforeSwapReturnDelta: 'CRITICAL',
  afterSwapReturnDelta: 'HIGH',
  afterAddLiquidityReturnDelta: 'HIGH',
  afterRemoveLiquidityReturnDelta: 'HIGH',
});

export const RETURN_DELTA_FLAGS = [
  'beforeSwapReturnDelta',
  'afterSwapReturnDelta',
  'afterAddLiquidityReturnDelta',
  'afterRemoveLiquidityReturnDelta',
] as const satisfies readonly HookPermissionFlag[];

export function permissionsBitmap(hookAddress: string): number {
  if (!/^0x[0-9a-fA-F]{40}$/.test(hookAddress))
    throw new Error(`Invalid hook address: ${hookAddress}`);
  return Number(BigInt(hookAddress) & BigInt(ALL_HOOK_MASK));
}

export function decodeHookPermissions(hookAddress: string): HookPermissions {
  const bits = permissionsBitmap(hookAddress);
  const out = {} as HookPermissions;
  for (const flag of HOOK_PERMISSION_FLAGS) {
    out[flag] = (bits & (1 << HOOK_FLAG_BITS[flag])) !== 0;
  }
  return out;
}

export function enabledPermissions(permissions: HookPermissions) {
  return HOOK_PERMISSION_FLAGS.filter((flag) => permissions[flag]).map((flag) => ({
    flag,
    bit: HOOK_FLAG_BITS[flag],
    risk: PERMISSION_RISK[flag],
  }));
}

export function isZeroHook(hookAddress: string): boolean {
  return /^0x0{40}$/i.test(hookAddress);
}
