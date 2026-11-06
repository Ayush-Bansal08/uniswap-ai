/** Shared LP helpers: load a v4 pool by poolId, and build exit (claim/decrease) steps. */
import { getAddress, type Address, type Hex } from 'viem';
import { getChain } from '../chains.js';
import type { PoolKeyOnChain } from '../clients/rpc.js';
import type { ToolDeps } from '../context.js';
import { invalidInput, McpToolError } from '../errors.js';
import type { TokenInfo, TxStep } from '../schemas.js';
import { validateTx } from '../tx.js';
import { normalizeSlippage } from './quote.js';
import { poolIdOf, sdkPool, sortTokens } from '../v4/math.js';

export interface LoadedPool {
  poolId: Hex;
  key: PoolKeyOnChain;
  token0: TokenInfo;
  token1: TokenInfo;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  sdk: ReturnType<typeof sdkPool>;
}

/** Resolve token0/token1 inputs and check they are in v4 currency order. */
export async function resolvePair(deps: ToolDeps, chainId: number, token0: string, token1: string) {
  const [a, b] = await Promise.all([
    deps.tokens.resolve(chainId, token0),
    deps.tokens.resolve(chainId, token1),
  ]);
  if (a.address === b.address) throw invalidInput('token0 and token1 must differ');
  const [t0, t1] = sortTokens(a, b);
  if (t0.address !== a.address) {
    throw invalidInput(
      `token0 must sort below token1 (v4 currency order): pass token0=${t0.symbol}, token1=${t1.symbol}`
    );
  }
  return { token0: a, token1: b };
}

/**
 * Pool key from PositionManager.poolKeys(bytes25(poolId)) (set once any position was minted
 * there), else from the LP API /lp/pool_info by reference. Live state from StateView.
 */
export async function loadPool(
  deps: ToolDeps,
  chainId: number,
  poolReference: string,
  token0: TokenInfo,
  token1: TokenInfo
): Promise<LoadedPool> {
  const chain = getChain(chainId);
  const reader = deps.reader(chainId);
  const poolId = poolReference.toLowerCase() as Hex;
  let key = await reader.poolKeyById(chain.positionManager, poolId).catch(() => null);
  if (!key) {
    const info = await deps.lp.poolInfo({
      protocol: 'V4',
      chainId: chainId as never,
      poolReferences: [{ protocol: 'V4', chainId: chainId as never, referenceIdentifier: poolId }],
    });
    const p = info.pools?.find((x) => x.poolReferenceIdentifier?.toLowerCase() === poolId);
    if (p && p.fee !== undefined && p.tickSpacing !== undefined) {
      key = {
        currency0: token0.address as Address,
        currency1: token1.address as Address,
        fee: Number(p.fee),
        tickSpacing: Number(p.tickSpacing),
        hooks: getAddress(
          p.hookAddress && /^0x[0-9a-fA-F]{40}$/.test(p.hookAddress)
            ? p.hookAddress
            : '0x0000000000000000000000000000000000000000'
        ),
      };
    }
  }
  if (!key)
    throw new McpToolError('POOL_NOT_FOUND', `Pool ${poolId} was not found on chain ${chainId}`, {
      retryable: false,
    });
  if (
    key.currency0.toLowerCase() !== token0.address.toLowerCase() ||
    key.currency1.toLowerCase() !== token1.address.toLowerCase()
  ) {
    throw invalidInput(
      `Pool ${poolId} is ${key.currency0}/${key.currency1}, not ${token0.symbol}/${token1.symbol}`
    );
  }
  const computed = poolIdOf(chainId, token0, token1, key.fee, key.tickSpacing, key.hooks);
  if (computed.toLowerCase() !== poolId) {
    throw invalidInput(
      `poolReference ${poolId} does not match its pool key (computed ${computed})`
    );
  }
  const [slot0, liquidity] = await Promise.all([
    reader.getSlot0(chain.stateView, poolId),
    reader.getLiquidity(chain.stateView, poolId),
  ]);
  if (slot0.sqrtPriceX96 === 0n) {
    throw new McpToolError('POOL_NOT_FOUND', `Pool ${poolId} is not initialized`, {
      retryable: false,
    });
  }
  return {
    poolId,
    key,
    token0,
    token1,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: slot0.tick,
    liquidity,
    sdk: sdkPool(
      chainId,
      { token0, token1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks },
      {
        sqrtPriceX96: slot0.sqrtPriceX96,
        tick: slot0.tick,
        liquidity,
      }
    ),
  };
}

export async function assertPositionOwner(
  deps: ToolDeps,
  chainId: number,
  tokenId: string,
  owner: Address
) {
  const holder = await deps
    .reader(chainId)
    .ownerOf(getChain(chainId).positionManager, BigInt(tokenId));
  if (!holder)
    throw new McpToolError(
      'POSITION_NOT_FOUND',
      `Position #${tokenId} does not exist on chain ${chainId}`,
      { retryable: false }
    );
  if (holder !== getAddress(owner)) {
    throw invalidInput(`Position #${tokenId} is owned by ${holder}, not ${owner}`);
  }
}

/** /lp/claim_fees (optional) then /lp/decrease, both validated against the PositionManager. */
export async function exitSteps(
  deps: ToolDeps,
  args: {
    chainId: number;
    owner: Address;
    token0: TokenInfo;
    token1: TokenInfo;
    tokenId: string;
    percent: number;
    claimFees: boolean;
    slippagePct?: number;
  }
): Promise<{ steps: TxStep[]; amount0: string; amount1: string }> {
  const chain = getChain(args.chainId);
  const expect = { chainId: args.chainId, from: args.owner, allowedTo: [chain.positionManager] };
  const steps: TxStep[] = [];
  if (args.claimFees && args.percent < 100) {
    const claim = await deps.lp.claimFees({
      protocol: 'V4',
      walletAddress: args.owner,
      chainId: args.chainId as never,
      tokenId: args.tokenId,
      simulateTransaction: false,
    });
    steps.push(
      validateTx('LP_CLAIM', `Collect fees from position #${args.tokenId}`, claim.claim, expect)
    );
  }
  const decrease = await deps.lp.decrease({
    walletAddress: args.owner,
    chainId: args.chainId as never,
    protocol: 'V4',
    token0Address: args.token0.address,
    token1Address: args.token1.address,
    nftTokenId: args.tokenId,
    liquidityPercentageToDecrease: args.percent,
    simulateTransaction: false,
    ...(args.slippagePct !== undefined
      ? { slippageTolerance: normalizeSlippage(args.slippagePct) }
      : {}),
  });
  steps.push(
    validateTx(
      'LP_DECREASE',
      `Remove ${args.percent}% of position #${args.tokenId} (${args.token0.symbol}/${args.token1.symbol})`,
      decrease.decrease,
      expect
    )
  );
  return { steps, amount0: decrease.token0.amount, amount1: decrease.token1.amount };
}
