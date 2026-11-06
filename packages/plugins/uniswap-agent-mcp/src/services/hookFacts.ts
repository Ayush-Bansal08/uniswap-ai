/**
 * On-chain facts about a hook contract, used by score_hook, get_hook_state and compare_pools.
 * Optional sources (Etherscan, subgraph, log scans) degrade to `null` instead of failing.
 */
import { getAddress, toFunctionSelector, type Address, type Hex } from 'viem';
import { Decimal } from '../amounts.js';
import { cacheKey, TTL } from '../cache.js';
import { DYNAMIC_FEE_FLAG, MAINNET_CHAIN_ID } from '../chains.js';
import { codeHashOf } from '../clients/rpc.js';
import type { ToolDeps } from '../context.js';
import { decodeHookPermissions } from '../hooks/permissions.js';
import { computeHookScore } from '../hooks/score.js';
import type { HookFacts, ScoreHookOutput } from '../schemas.js';
import { scanInitializeLogs } from './initializeScan.js';

/** Storage slots for proxy detection. */
export const PROXY_SLOTS = Object.freeze({
  /** EIP-1967 implementation: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1) */
  eip1967Implementation:
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex,
  /** EIP-1967 admin: bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1) */
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as Hex,
  /** EIP-1967 beacon: bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1) */
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as Hex,
  /** EIP-1822 (UUPS, legacy): keccak256('PROXIABLE') */
  eip1822Proxiable: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7' as Hex,
});

/** Privileged setters whose presence (as PUSH4 dispatch selectors) means params can change. */
export const ADMIN_SETTER_SIGNATURES = [
  'setFee(uint24)',
  'setFees(uint24,uint24)',
  'setLpFee(uint24)',
  'setSwapFee(uint24)',
  'setDynamicFee(uint24)',
  'updateFee(uint24)',
  'updateDynamicLPFee((address,address,uint24,int24,address),uint24)',
  'setProtocolFee(uint24)',
  'setFeeRecipient(address)',
  'setOracle(address)',
  'setConfig(bytes)',
  'setParameters(bytes)',
  'pause()',
  'unpause()',
  'setPaused(bool)',
  'setAllowlist(address,bool)',
  'setRouter(address,bool)',
  'withdraw(address,uint256)',
  'rescueTokens(address,address,uint256)',
  'sweep(address,address)',
  'upgradeTo(address)',
  'upgradeToAndCall(address,bytes)',
] as const;

const SELECTORS = ADMIN_SETTER_SIGNATURES.map((signature) => ({
  signature,
  selector: toFunctionSelector(signature).slice(2).toLowerCase(),
}));

const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

export function scanAdminSelectors(...codes: (Hex | undefined)[]): string[] {
  const hex = codes.filter(Boolean).join('').toLowerCase();
  // PUSH4 (0x63) followed by the selector — how solc's dispatcher compares selectors.
  return SELECTORS.filter((s) => hex.includes(`63${s.selector}`)).map((s) => s.signature);
}

function slotToAddress(value: Hex | undefined): Address | null {
  if (!value || /^0x0*$/.test(value)) return null;
  const hex = value.slice(-40);
  return /^0+$/.test(hex) ? null : getAddress(`0x${hex}`);
}

export function minimalProxyTarget(code: Hex | undefined): Address | null {
  if (!code) return null;
  const hex = code.slice(2).toLowerCase();
  if (hex.length === 90 && hex.startsWith(EIP1167_PREFIX) && hex.endsWith(EIP1167_SUFFIX)) {
    return getAddress(`0x${hex.slice(20, 60)}`);
  }
  return null;
}

export async function detectProxy(
  deps: ToolDeps,
  chainId: number,
  address: Address,
  code: Hex | undefined
) {
  const reader = deps.reader(chainId);
  const [impl, admin, beacon, proxiable] = await Promise.all([
    reader.getStorageAt(address, PROXY_SLOTS.eip1967Implementation),
    reader.getStorageAt(address, PROXY_SLOTS.eip1967Admin),
    reader.getStorageAt(address, PROXY_SLOTS.eip1967Beacon),
    reader.getStorageAt(address, PROXY_SLOTS.eip1822Proxiable),
  ]);
  const implementation = slotToAddress(impl);
  const beaconAddr = slotToAddress(beacon);
  const proxiableImpl = slotToAddress(proxiable);
  const clone = minimalProxyTarget(code);
  if (implementation)
    return {
      kind: 'EIP1967' as const,
      implementation,
      admin: slotToAddress(admin),
      beacon: null,
      upgradeable: true,
    };
  if (beaconAddr)
    return {
      kind: 'BEACON' as const,
      implementation: null,
      admin: slotToAddress(admin),
      beacon: beaconAddr,
      upgradeable: true,
    };
  if (proxiableImpl)
    return {
      kind: 'EIP1822' as const,
      implementation: proxiableImpl,
      admin: null,
      beacon: null,
      upgradeable: true,
    };
  if (clone)
    return {
      kind: 'EIP1167' as const,
      implementation: clone,
      admin: null,
      beacon: null,
      upgradeable: false,
    };
  return { kind: null, implementation: null, admin: null, beacon: null, upgradeable: false };
}

export async function gatherHookFacts(
  deps: ToolDeps,
  chainId: number,
  hookAddress: Address
): Promise<HookFacts> {
  const reader = deps.reader(chainId);
  const code = await reader.getCode(hookAddress);
  const hasCode = !!code && code !== '0x';
  const proxy = hasCode
    ? await detectProxy(deps, chainId, hookAddress, code)
    : { kind: null, implementation: null, admin: null, beacon: null, upgradeable: false };
  const implCode = proxy.implementation ? await reader.getCode(proxy.implementation) : undefined;
  const owner = hasCode ? await reader.readOwner(hookAddress) : null;

  const [source, usage] = await Promise.all([
    hasCode ? deps.etherscan.sourceInfo(chainId, hookAddress) : Promise.resolve(null),
    hookUsage(deps, chainId, hookAddress),
  ]);

  const nowSec = Math.floor(deps.now() / 1000);
  let firstSeenAt = usage.firstSeenUnix;
  let firstSeenBlock = usage.firstSeenBlock;
  let ageSource = usage.firstSeenUnix !== null ? usage.source : null;
  if (firstSeenAt === null && hasCode) {
    const creation = await deps.etherscan.creation(chainId, hookAddress);
    if (creation?.timestamp) {
      firstSeenAt = creation.timestamp;
      firstSeenBlock = creation.blockNumber?.toString() ?? null;
      ageSource = 'Etherscan contract creation';
    } else if (creation?.blockNumber) {
      firstSeenBlock = creation.blockNumber.toString();
      firstSeenAt = await reader.getBlockTimestamp(creation.blockNumber).catch(() => null);
      ageSource = firstSeenAt !== null ? 'Etherscan contract creation block' : null;
    }
  }

  return {
    hasCode,
    codeSizeBytes: hasCode ? (code!.length - 2) / 2 : 0,
    codeHash: codeHashOf(code),
    proxy,
    owner: owner && !/^0x0{40}$/i.test(owner) ? owner : null,
    adminSelectors: hasCode ? scanAdminSelectors(code, implCode) : [],
    verifiedSource: source ? source.verified : null,
    contractName: source?.contractName ?? null,
    firstSeenBlock,
    firstSeenAt: firstSeenAt !== null ? new Date(firstSeenAt * 1000).toISOString() : null,
    ageDays: firstSeenAt !== null ? Math.max(0, (nowSec - firstSeenAt) / 86_400) : null,
    ageSource,
    poolCount: usage.poolCount,
    dynamicFeePoolCount: usage.dynamicFeePoolCount,
    tvlUsd: usage.tvlUsd,
  };
}

interface HookUsage {
  poolCount: number | null;
  dynamicFeePoolCount: number | null;
  tvlUsd: string | null;
  firstSeenUnix: number | null;
  firstSeenBlock: string | null;
  source: string;
  poolIds: string[];
}

/** Pools that use the hook: mainnet subgraph, or Initialize logs (last 30 days) on the execution chain. */
export async function hookUsage(
  deps: ToolDeps,
  chainId: number,
  hookAddress: Address
): Promise<HookUsage> {
  const empty: HookUsage = {
    poolCount: null,
    dynamicFeePoolCount: null,
    tvlUsd: null,
    firstSeenUnix: null,
    firstSeenBlock: null,
    source: 'none',
    poolIds: [],
  };
  try {
    if (chainId === MAINNET_CHAIN_ID) {
      if (!deps.subgraph.configured) return empty;
      const { pools } = await deps.subgraph.poolsByHook(hookAddress);
      const first = pools[0];
      return {
        poolCount: pools.length,
        dynamicFeePoolCount: pools.filter((p) => Number(p.feeTier) === DYNAMIC_FEE_FLAG).length,
        tvlUsd: pools
          .reduce((acc, p) => acc.plus(p.totalValueLockedUSD || '0'), new Decimal(0))
          .toFixed(2),
        firstSeenUnix: first ? Number(first.createdAtTimestamp) : null,
        firstSeenBlock: first ? first.createdAtBlockNumber : null,
        source: 'v4 subgraph (first pool created)',
        poolIds: pools.map((p) => p.id),
      };
    }
    const scan = await scanInitializeLogs(deps, chainId, { sinceDays: 30 });
    const mine = scan.logs.filter((l) => l.hooks.toLowerCase() === hookAddress.toLowerCase());
    const first = mine[0];
    const firstSeenUnix = first
      ? await deps.reader(chainId).getBlockTimestamp(first.blockNumber)
      : null;
    return {
      poolCount: mine.length,
      dynamicFeePoolCount: mine.filter((l) => l.fee === DYNAMIC_FEE_FLAG).length,
      tvlUsd: null,
      firstSeenUnix,
      firstSeenBlock: first ? first.blockNumber.toString() : null,
      source: 'PoolManager Initialize logs (last 30 days)',
      poolIds: mine.map((l) => l.poolId),
    };
  } catch (err) {
    deps.log.warn('hook usage lookup failed', {
      chainId,
      hookAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

/** Facts + deterministic score, cached 5 min. */
export function scoreHookCached(
  deps: ToolDeps,
  chainId: number,
  hookAddress: Address
): Promise<ScoreHookOutput> {
  const hook = getAddress(hookAddress);
  return deps.cache.wrap(cacheKey('score-hook', { chainId, hook }), TTL.hooks, async () => {
    const facts = await gatherHookFacts(deps, chainId, hook);
    return computeHookScore({
      chainId,
      hookAddress: hook,
      permissions: decodeHookPermissions(hook),
      facts,
      now: new Date(deps.now()),
    });
  });
}
