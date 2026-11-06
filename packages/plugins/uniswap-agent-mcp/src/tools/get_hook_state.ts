/**
 * get_hook_state — a point-in-time snapshot of a hook for change detection (code hash,
 * implementation, owner, per-pool fees/price/liquidity). Pure read; diffing is the caller's job.
 */
import { getAddress, type Hex } from 'viem';
import { getChain, MAINNET_CHAIN_ID } from '../chains.js';
import { codeHashOf } from '../clients/rpc.js';
import { requireReadableChain } from '../context.js';
import { permissionsBitmap } from '../hooks/permissions.js';
import { GetHookStateInputSchema, GetHookStateOutputSchema } from '../schemas.js';
import { detectProxy, hookUsage } from '../services/hookFacts.js';
import { defineTool, short } from './define.js';

const MAX_POOLS = 50;

export const getHookStateTool = defineTool({
  name: 'get_hook_state',
  title: 'Hook state snapshot',
  description:
    'Snapshot of a Uniswap v4 hook for "hook changed" detection: codeHash, proxy implementation (+ its codeHash), owner, permission bitmap, and for each pool (given poolIds, or discovered via the mainnet subgraph / execution-chain Initialize logs) the StateView lpFee, protocolFee, sqrtPriceX96, tick and liquidity, with block number and takenAt. Read-only; compare two snapshots to detect changes.',
  kind: 'read',
  input: GetHookStateInputSchema,
  output: GetHookStateOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    const chain = getChain(args.chainId);
    const hook = getAddress(args.hookAddress);
    const reader = deps.reader(args.chainId);
    const [blockNumber, code] = await Promise.all([reader.getBlockNumber(), reader.getCode(hook)]);
    const hasCode = !!code && code !== '0x';
    const proxy = hasCode ? await detectProxy(deps, args.chainId, hook, code) : null;
    const [implCode, owner] = await Promise.all([
      proxy?.implementation ? reader.getCode(proxy.implementation) : Promise.resolve(undefined),
      hasCode ? reader.readOwner(hook) : Promise.resolve(null),
    ]);

    let poolIds: string[] = args.poolIds ?? [];
    let poolDiscovery: 'input' | 'subgraph' | 'logs' | 'none' = 'input';
    if (!args.poolIds) {
      const usage = await hookUsage(deps, args.chainId, hook);
      poolIds = usage.poolIds.slice(0, MAX_POOLS);
      poolDiscovery =
        poolIds.length === 0 ? 'none' : args.chainId === MAINNET_CHAIN_ID ? 'subgraph' : 'logs';
    }

    const pools = await Promise.all(
      poolIds.map(async (id) => {
        const poolId = id.toLowerCase() as Hex;
        const [slot0, liquidity] = await Promise.all([
          reader.getSlot0(chain.stateView, poolId),
          reader.getLiquidity(chain.stateView, poolId),
        ]);
        return {
          poolId,
          lpFee: slot0.lpFee,
          protocolFee: slot0.protocolFee,
          sqrtPriceX96: slot0.sqrtPriceX96.toString(),
          tick: slot0.tick,
          liquidity: liquidity.toString(),
        };
      })
    );

    return {
      chainId: args.chainId,
      hookAddress: hook,
      hasCode,
      codeHash: codeHashOf(code),
      implementation: proxy?.implementation ?? null,
      implementationCodeHash: codeHashOf(implCode),
      owner: owner && !/^0x0{40}$/i.test(owner) ? owner : null,
      permissionsBitmap: permissionsBitmap(hook),
      pools,
      poolDiscovery,
      blockNumber: blockNumber.toString(),
      takenAt: new Date(deps.now()).toISOString(),
    };
  },
  summarize(o) {
    return `Hook ${short(o.hookAddress)} on chain ${o.chainId} at block ${
      o.blockNumber
    }: codeHash ${o.codeHash?.slice(0, 12) ?? 'none'}…${
      o.implementation ? `, implementation ${short(o.implementation)}` : ''
    }${o.owner ? `, owner ${short(o.owner)}` : ''}; ${o.pools.length} pool(s) (${
      o.poolDiscovery
    }).`;
  },
});
