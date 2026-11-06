/**
 * Scan PoolManager `Initialize` events on the execution chain in block windows
 * (LOGS_BLOCK_WINDOW, default 5 000; halved automatically when the RPC rejects a range).
 * The scan starts at the PoolManager deployment block, which the vendored deployment docs do
 * not list, so it is discovered once via binary search on eth_getCode (cached 24 h).
 */
import type { Address } from 'viem';
import { TTL } from '../cache.js';
import { getChain } from '../chains.js';
import { findDeploymentBlock, type InitializeLog } from '../clients/rpc.js';
import type { ToolDeps } from '../context.js';
import { McpToolError } from '../errors.js';

export const MAX_LOG_CALLS = 500;

export interface InitializeScan {
  logs: InitializeLog[];
  fromBlock: bigint;
  toBlock: bigint;
  truncated: boolean;
}

export async function poolManagerStartBlock(deps: ToolDeps, chainId: number): Promise<bigint> {
  const chain = getChain(chainId);
  if (chain.poolManagerStartBlock !== null) return chain.poolManagerStartBlock;
  const block = await deps.cache.wrap(`pm-start:${chainId}`, TTL.deployBlock, async () =>
    (await findDeploymentBlock(deps.reader(chainId), chain.poolManager)).toString()
  );
  return BigInt(block);
}

export async function scanInitializeLogs(
  deps: ToolDeps,
  chainId: number,
  options: { sinceDays: number; filter?: { currency0?: Address; currency1?: Address } }
): Promise<InitializeScan> {
  const key = `init-scan:${chainId}:${options.sinceDays}:${options.filter?.currency0 ?? ''}:${
    options.filter?.currency1 ?? ''
  }`;
  const cached = await deps.cache.wrap(key, TTL.hooks, async () => {
    const chain = getChain(chainId);
    const reader = deps.reader(chainId);
    const [latest, start] = await Promise.all([
      reader.getBlockNumber(),
      poolManagerStartBlock(deps, chainId),
    ]);
    const blocksPerDay = BigInt(Math.ceil(86_400 / chain.blockTimeSeconds));
    const sinceBlock = latest - BigInt(options.sinceDays) * blocksPerDay;
    const fromBlock = sinceBlock > start ? sinceBlock : start;

    const logs: InitializeLog[] = [];
    let window = BigInt(deps.config.LOGS_BLOCK_WINDOW);
    let cursor = fromBlock;
    let calls = 0;
    let truncated = false;
    while (cursor <= latest) {
      if (calls >= MAX_LOG_CALLS) {
        truncated = true;
        break;
      }
      const end = cursor + window - 1n > latest ? latest : cursor + window - 1n;
      calls += 1;
      try {
        logs.push(
          ...(await reader.getInitializeLogs(chain.poolManager, cursor, end, options.filter))
        );
        cursor = end + 1n;
      } catch (err) {
        if (err instanceof McpToolError && err.code === 'RPC_ERROR' && window > 10n) {
          window = window / 2n; // provider range limit — shrink and retry this chunk
          continue;
        }
        throw err;
      }
    }
    return {
      logs: logs.map((l) => ({ ...l, blockNumber: l.blockNumber.toString() })),
      fromBlock: fromBlock.toString(),
      toBlock: (truncated ? cursor - 1n : latest).toString(),
      truncated,
    };
  });
  return {
    logs: cached.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) })),
    fromBlock: BigInt(cached.fromBlock),
    toBlock: BigInt(cached.toBlock),
    truncated: cached.truncated,
  };
}
