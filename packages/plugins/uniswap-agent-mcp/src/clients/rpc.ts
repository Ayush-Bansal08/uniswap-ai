/**
 * On-chain reads via viem public clients (execution chain + mainnet). Exposed through the
 * narrow `ChainReader` interface so tools stay readable and tests can supply fakes.
 * Read-only: there is no wallet client anywhere in this package.
 */
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { baseSepolia, mainnet, sepolia, unichainSepolia } from 'viem/chains';
import { McpToolError } from '../errors.js';
import {
  erc20MetadataAbi,
  ownableAbi,
  poolManagerInitializeEvent,
  positionManagerAbi,
  stateViewAbi,
  v4QuoterAbi,
} from './abis.js';

export interface PoolKeyOnChain {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

export interface Erc20Metadata {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface InitializeLog {
  poolId: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  blockNumber: bigint;
}

export interface ChainReader {
  readonly chainId: number;
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(blockNumber: bigint): Promise<number>;
  getBalance(address: Address): Promise<bigint>;
  getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
  erc20Metadata(tokens: readonly Address[]): Promise<Erc20Metadata[]>;
  erc20Balances(owner: Address, tokens: readonly Address[]): Promise<bigint[]>;
  /** `owner()` if the contract implements it (Ownable), else null. */
  readOwner(address: Address): Promise<Address | null>;
  quoteExactSingle(
    quoter: Address,
    kind: 'EXACT_INPUT' | 'EXACT_OUTPUT',
    params: { poolKey: PoolKeyOnChain; zeroForOne: boolean; exactAmount: bigint; hookData: Hex }
  ): Promise<{ amount: bigint; gasEstimate: bigint }>;
  /** Pool slot0; pass `blockNumber` for a historical (archive) read. */
  getSlot0(stateView: Address, poolId: Hex, blockNumber?: bigint): Promise<Slot0>;
  getLiquidity(stateView: Address, poolId: Hex): Promise<bigint>;
  getPositionFeeState(
    stateView: Address,
    args: {
      poolId: Hex;
      owner: Address;
      tickLower: number;
      tickUpper: number;
      salt: Hex;
    }
  ): Promise<{
    liquidity: bigint;
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
    feeGrowthInside0X128: bigint;
    feeGrowthInside1X128: bigint;
  }>;
  getPoolAndPositionInfo(
    positionManager: Address,
    tokenId: bigint
  ): Promise<{ poolKey: PoolKeyOnChain; info: bigint }>;
  getPositionLiquidity(positionManager: Address, tokenId: bigint): Promise<bigint>;
  ownerOf(positionManager: Address, tokenId: bigint): Promise<Address | null>;
  /** PositionManager.poolKeys(bytes25) — set for pools that ever had a PositionManager mint. */
  poolKeyById(positionManager: Address, poolId: Hex): Promise<PoolKeyOnChain | null>;
  getInitializeLogs(
    poolManager: Address,
    fromBlock: bigint,
    toBlock: bigint,
    filter?: { currency0?: Address; currency1?: Address }
  ): Promise<InitializeLog[]>;
}

const VIEM_CHAINS: Record<number, Chain> = {
  1: mainnet,
  11155111: sepolia,
  84532: baseSepolia,
  1301: unichainSepolia,
};

function rpcError(chainId: number, what: string, err: unknown): McpToolError {
  const message =
    err instanceof Error
      ? (err as { shortMessage?: string }).shortMessage ?? err.message
      : String(err);
  return new McpToolError(
    'RPC_ERROR',
    `RPC (chain ${chainId}) ${what} failed: ${message.slice(0, 300)}`,
    {
      cause: err,
    }
  );
}

export class ViemChainReader implements ChainReader {
  readonly client: PublicClient;

  constructor(readonly chainId: number, rpcUrl: string, options: { timeoutMs?: number } = {}) {
    const chain = VIEM_CHAINS[chainId];
    this.client = createPublicClient({
      ...(chain ? { chain } : {}),
      transport: http(rpcUrl, { timeout: options.timeoutMs ?? 10_000, retryCount: 3 }),
      batch: { multicall: { wait: 10 } },
    }) as PublicClient;
  }

  private async run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      throw rpcError(this.chainId, what, err);
    }
  }

  getBlockNumber(): Promise<bigint> {
    return this.run('eth_blockNumber', () => this.client.getBlockNumber({ cacheTime: 2_000 }));
  }

  getBlockTimestamp(blockNumber: bigint): Promise<number> {
    return this.run('eth_getBlockByNumber', async () =>
      Number((await this.client.getBlock({ blockNumber })).timestamp)
    );
  }

  getBalance(address: Address): Promise<bigint> {
    return this.run('eth_getBalance', () => this.client.getBalance({ address }));
  }

  getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined> {
    return this.run('eth_getCode', () =>
      this.client.getCode(blockNumber !== undefined ? { address, blockNumber } : { address })
    );
  }

  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined> {
    return this.run('eth_getStorageAt', () => this.client.getStorageAt({ address, slot }));
  }

  async erc20Metadata(tokens: readonly Address[]): Promise<Erc20Metadata[]> {
    if (tokens.length === 0) return [];
    const contracts = tokens.flatMap((address) =>
      (['symbol', 'name', 'decimals'] as const).map((functionName) => ({
        address,
        abi: erc20MetadataAbi,
        functionName,
      }))
    );
    const results = await this.run('multicall(erc20 metadata)', () =>
      this.client.multicall({ contracts, allowFailure: true })
    );
    return tokens.map((_, i) => {
      const [symbol, name, decimals] = [results[i * 3], results[i * 3 + 1], results[i * 3 + 2]];
      return {
        symbol: symbol?.status === 'success' ? String(symbol.result) : null,
        name: name?.status === 'success' ? String(name.result) : null,
        decimals: decimals?.status === 'success' ? Number(decimals.result) : null,
      };
    });
  }

  async erc20Balances(owner: Address, tokens: readonly Address[]): Promise<bigint[]> {
    if (tokens.length === 0) return [];
    const results = await this.run('multicall(balanceOf)', () =>
      this.client.multicall({
        contracts: tokens.map((address) => ({
          address,
          abi: erc20MetadataAbi,
          functionName: 'balanceOf' as const,
          args: [owner] as const,
        })),
        allowFailure: true,
      })
    );
    return results.map((r) => (r.status === 'success' ? (r.result as bigint) : 0n));
  }

  async readOwner(address: Address): Promise<Address | null> {
    try {
      const owner = await this.client.readContract({
        address,
        abi: ownableAbi,
        functionName: 'owner',
      });
      return getAddress(owner);
    } catch {
      return null;
    }
  }

  quoteExactSingle(
    quoter: Address,
    kind: 'EXACT_INPUT' | 'EXACT_OUTPUT',
    params: { poolKey: PoolKeyOnChain; zeroForOne: boolean; exactAmount: bigint; hookData: Hex }
  ): Promise<{ amount: bigint; gasEstimate: bigint }> {
    // v4-sdk-integration skill: the Quoter is NOT view — simulate through eth_call, never send it.
    return this.run(
      `V4Quoter.${kind === 'EXACT_INPUT' ? 'quoteExactInputSingle' : 'quoteExactOutputSingle'}`,
      async () => {
        const { result } = await this.client.simulateContract({
          address: quoter,
          abi: v4QuoterAbi,
          functionName: kind === 'EXACT_INPUT' ? 'quoteExactInputSingle' : 'quoteExactOutputSingle',
          args: [params],
        });
        const [amount, gasEstimate] = result;
        return { amount, gasEstimate };
      }
    );
  }

  getSlot0(stateView: Address, poolId: Hex, blockNumber?: bigint): Promise<Slot0> {
    return this.run('StateView.getSlot0', async () => {
      const [sqrtPriceX96, tick, protocolFee, lpFee] = await this.client.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: 'getSlot0',
        args: [poolId],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
      return {
        sqrtPriceX96,
        tick: Number(tick),
        protocolFee: Number(protocolFee),
        lpFee: Number(lpFee),
      };
    });
  }

  getLiquidity(stateView: Address, poolId: Hex): Promise<bigint> {
    return this.run('StateView.getLiquidity', () =>
      this.client.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: 'getLiquidity',
        args: [poolId],
      })
    );
  }

  getPositionFeeState(
    stateView: Address,
    args: { poolId: Hex; owner: Address; tickLower: number; tickUpper: number; salt: Hex }
  ) {
    return this.run('StateView.getPositionInfo/getFeeGrowthInside', async () => {
      const [info, inside] = await Promise.all([
        this.client.readContract({
          address: stateView,
          abi: stateViewAbi,
          functionName: 'getPositionInfo',
          args: [args.poolId, args.owner, args.tickLower, args.tickUpper, args.salt],
        }),
        this.client.readContract({
          address: stateView,
          abi: stateViewAbi,
          functionName: 'getFeeGrowthInside',
          args: [args.poolId, args.tickLower, args.tickUpper],
        }),
      ]);
      return {
        liquidity: info[0],
        feeGrowthInside0LastX128: info[1],
        feeGrowthInside1LastX128: info[2],
        feeGrowthInside0X128: inside[0],
        feeGrowthInside1X128: inside[1],
      };
    });
  }

  getPoolAndPositionInfo(positionManager: Address, tokenId: bigint) {
    return this.run('PositionManager.getPoolAndPositionInfo', async () => {
      const [poolKey, info] = await this.client.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: 'getPoolAndPositionInfo',
        args: [tokenId],
      });
      return {
        poolKey: {
          currency0: getAddress(poolKey.currency0),
          currency1: getAddress(poolKey.currency1),
          fee: Number(poolKey.fee),
          tickSpacing: Number(poolKey.tickSpacing),
          hooks: getAddress(poolKey.hooks),
        },
        info,
      };
    });
  }

  getPositionLiquidity(positionManager: Address, tokenId: bigint): Promise<bigint> {
    return this.run('PositionManager.getPositionLiquidity', () =>
      this.client.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      })
    );
  }

  async ownerOf(positionManager: Address, tokenId: bigint): Promise<Address | null> {
    try {
      const owner = await this.client.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: 'ownerOf',
        args: [tokenId],
      });
      return getAddress(owner);
    } catch {
      return null; // burned or never minted
    }
  }

  poolKeyById(positionManager: Address, poolId: Hex): Promise<PoolKeyOnChain | null> {
    return this.run('PositionManager.poolKeys', async () => {
      const bytes25 = poolId.slice(0, 2 + 50) as Hex;
      const [currency0, currency1, fee, tickSpacing, hooks] = await this.client.readContract({
        address: positionManager,
        abi: positionManagerAbi,
        functionName: 'poolKeys',
        args: [bytes25],
      });
      if (Number(tickSpacing) === 0) return null;
      return {
        currency0: getAddress(currency0),
        currency1: getAddress(currency1),
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks: getAddress(hooks),
      };
    });
  }

  getInitializeLogs(
    poolManager: Address,
    fromBlock: bigint,
    toBlock: bigint,
    filter: { currency0?: Address; currency1?: Address } = {}
  ): Promise<InitializeLog[]> {
    return this.run('eth_getLogs(Initialize)', async () => {
      const logs = await this.client.getLogs({
        address: poolManager,
        event: poolManagerInitializeEvent,
        args: {
          ...(filter.currency0 ? { currency0: filter.currency0 } : {}),
          ...(filter.currency1 ? { currency1: filter.currency1 } : {}),
        },
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((log) => {
        const decoded = decodeEventLog({
          abi: [poolManagerInitializeEvent],
          data: log.data,
          topics: log.topics,
        });
        return {
          poolId: decoded.args.id,
          currency0: getAddress(decoded.args.currency0),
          currency1: getAddress(decoded.args.currency1),
          fee: Number(decoded.args.fee),
          tickSpacing: Number(decoded.args.tickSpacing),
          hooks: getAddress(decoded.args.hooks),
          blockNumber: log.blockNumber ?? 0n,
        };
      });
    });
  }
}

/** keccak256 of runtime bytecode, or null when there is no code. */
export function codeHashOf(code: Hex | undefined): Hex | null {
  return code && code !== '0x' ? keccak256(code) : null;
}

/**
 * Binary-search the first block where `address` has code (needs an archive-capable RPC).
 * Used for the PoolManager start block, which the vendor deployment docs do not list.
 */
export async function findDeploymentBlock(reader: ChainReader, address: Address): Promise<bigint> {
  const latest = await reader.getBlockNumber();
  const hasCode = async (block: bigint) => {
    const code = await reader.getCode(address, block);
    return !!code && code !== '0x';
  };
  if (!(await hasCode(latest))) {
    throw new McpToolError(
      'NOT_CONFIGURED',
      `No contract code at ${address} on chain ${reader.chainId}.`,
      {
        retryable: false,
      }
    );
  }
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}
