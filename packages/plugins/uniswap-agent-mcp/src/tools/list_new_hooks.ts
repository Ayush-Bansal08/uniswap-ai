/**
 * list_new_hooks — newly seen v4 hooks.
 *   market:    mainnet pools with a non-zero `hooks`, newest first. Failover: official v4 subgraph
 *              → v4 pool registry subgraph (+ GeckoTerminal TVL) → PoolManager logs (RPC)
 *   execution: PoolManager `Initialize` logs on the execution chain (5k-block windows)
 */
import { getAddress, type Address } from 'viem';
import type { z } from 'zod';
import { Decimal } from '../amounts.js';
import { DYNAMIC_FEE_FLAG, MAINNET_CHAIN_ID } from '../chains.js';
import type { ToolDeps } from '../context.js';
import { invalidInput } from '../errors.js';
import { isZeroHook } from '../hooks/permissions.js';
import { ListNewHooksInputSchema, ListNewHooksOutputSchema } from '../schemas.js';
import { newHookPools } from '../market/data.js';
import { scanInitializeLogs } from '../services/initializeScan.js';
import { sortTokens } from '../v4/math.js';
import { defineTool, short } from './define.js';

type Out = z.infer<typeof ListNewHooksOutputSchema>;
type HookGroup = Out['hooks'][number];

async function pairOn(deps: ToolDeps, chainId: number, pair: [string, string] | undefined) {
  if (!pair) return undefined;
  const [a, b] = await Promise.all(pair.map((t) => deps.tokens.resolve(chainId, t)));
  if (!a || !b || a.address === b.address) throw invalidInput('pair must be two different tokens');
  return sortTokens(a, b);
}

export const listNewHooksTool = defineTool({
  name: 'list_new_hooks',
  title: 'New v4 hooks',
  description:
    'List recently seen Uniswap v4 hooks with their pools. scope "market": Ethereum-mainnet pools with a non-zero hook, newest first, with TVL when known (official v4 subgraph, failing over to the v4 pool registry subgraph, then PoolManager logs; `source` says which). scope "execution": PoolManager Initialize events on the execution chain (eth_getLogs in 5k-block windows). Optional pair filter and sinceDays (default 30). Read-only.',
  kind: 'read',
  input: ListNewHooksInputSchema,
  output: ListNewHooksOutputSchema,
  async handler(args, deps) {
    const sinceDays = args.sinceDays ?? 30;
    const limit = args.limit ?? 20;
    const nowSec = Math.floor(deps.now() / 1000);

    if (args.scope === 'market') {
      // Pair symbols resolve on mainnet (market data lives there).
      const pair = await pairOn(deps, MAINNET_CHAIN_ID, args.pair);
      const first = Math.min(1000, limit * 10);
      // Failover: official subgraph → v4 pool registry subgraph → PoolManager logs (RPC).
      const listing = await newHookPools(deps, {
        sinceUnix: nowSec - sinceDays * 86_400,
        first,
        ...(pair ? { pair: [pair[0].address as Address, pair[1].address as Address] } : {}),
      });
      const groups = new Map<string, HookGroup>();
      for (const p of listing.data) {
        if (isZeroHook(p.hooks)) continue;
        const hook = getAddress(p.hooks);
        const group = groups.get(hook) ?? {
          hookAddress: hook,
          chainId: MAINNET_CHAIN_ID,
          pools: [],
          firstSeen: null,
          totalTvlUsd: null,
        };
        group.pools.push({
          poolId: p.poolId,
          token0: p.token0,
          token1: p.token1,
          token0Symbol: p.token0Symbol,
          token1Symbol: p.token1Symbol,
          fee: p.fee ?? 0,
          tickSpacing: p.tickSpacing ?? 0,
          isDynamicFee: p.fee === DYNAMIC_FEE_FLAG,
          tvlUsd: p.tvlUsd,
          createdAt: p.createdAt,
          createdAtBlock: p.createdAtBlock,
        });
        if (p.createdAt && (!group.firstSeen || p.createdAt < group.firstSeen))
          group.firstSeen = p.createdAt;
        if (p.tvlUsd !== null) {
          group.totalTvlUsd = new Decimal(group.totalTvlUsd ?? '0')
            .plus(p.tvlUsd)
            .toDecimalPlaces(2)
            .toFixed();
        }
        groups.set(hook, group);
      }
      const hooks = [...groups.values()]
        .sort((x, y) => (y.firstSeen ?? '').localeCompare(x.firstSeen ?? ''))
        .slice(0, limit);
      return {
        scope: 'market' as const,
        chainId: MAINNET_CHAIN_ID,
        sinceDays,
        hooks,
        scannedFromBlock: null,
        scannedToBlock: null,
        asOf: listing.asOf,
        truncated: listing.truncated || groups.size > limit,
        source: listing.sourceLabel,
        warnings: listing.warnings,
      };
    }

    const chainId = deps.executionChainId;
    const pair = await pairOn(deps, chainId, args.pair);
    const scan = await scanInitializeLogs(deps, chainId, {
      sinceDays,
      ...(pair
        ? {
            filter: {
              currency0: pair[0].address as Address,
              currency1: pair[1].address as Address,
            },
          }
        : {}),
    });
    const groups = new Map<string, { group: HookGroup; firstBlock: bigint }>();
    for (const log of scan.logs) {
      if (isZeroHook(log.hooks)) continue;
      const entry = groups.get(log.hooks) ?? {
        group: { hookAddress: log.hooks, chainId, pools: [], firstSeen: null, totalTvlUsd: null },
        firstBlock: log.blockNumber,
      };
      entry.group.pools.push({
        poolId: log.poolId.toLowerCase(),
        token0: log.currency0,
        token1: log.currency1,
        token0Symbol: deps.tokens.findAllowed(chainId, log.currency0)?.symbol ?? null,
        token1Symbol: deps.tokens.findAllowed(chainId, log.currency1)?.symbol ?? null,
        fee: log.fee,
        tickSpacing: log.tickSpacing,
        isDynamicFee: log.fee === DYNAMIC_FEE_FLAG,
        tvlUsd: null,
        createdAt: null,
        createdAtBlock: log.blockNumber.toString(),
      });
      if (log.blockNumber < entry.firstBlock) entry.firstBlock = log.blockNumber;
      groups.set(log.hooks, entry);
    }
    const newest = [...groups.values()]
      .sort((x, y) => (y.firstBlock > x.firstBlock ? 1 : y.firstBlock < x.firstBlock ? -1 : 0))
      .slice(0, limit);
    const reader = deps.reader(chainId);
    const hooks = await Promise.all(
      newest.map(async ({ group, firstBlock }) => {
        const ts = await reader.getBlockTimestamp(firstBlock).catch(() => null);
        const firstSeen = ts !== null ? new Date(ts * 1000).toISOString() : null;
        return {
          ...group,
          firstSeen,
          pools: group.pools.map((p) => ({
            ...p,
            createdAt: p.createdAtBlock === firstBlock.toString() ? firstSeen : null,
          })),
        };
      })
    );
    return {
      scope: 'execution' as const,
      chainId,
      sinceDays,
      hooks,
      scannedFromBlock: scan.fromBlock.toString(),
      scannedToBlock: scan.toBlock.toString(),
      asOf: new Date(deps.now()).toISOString(),
      truncated: scan.truncated || groups.size > limit,
      source: 'Uniswap v4 PoolManager Initialize logs (RPC)',
      warnings: [],
    };
  },
  summarize(o) {
    const top = o.hooks
      .slice(0, 5)
      .map(
        (h) =>
          `${short(h.hookAddress)} (${h.pools.length} pool${h.pools.length === 1 ? '' : 's'}${
            h.totalTvlUsd ? `, $${h.totalTvlUsd}` : ''
          })`
      );
    return `${o.hooks.length} hook(s) seen in the last ${o.sinceDays} days on chain ${o.chainId} (${
      o.scope
    })${top.length ? `: ${top.join(', ')}` : ''}${o.truncated ? ' [truncated]' : ''} via ${
      o.source
    }.`;
  },
});
