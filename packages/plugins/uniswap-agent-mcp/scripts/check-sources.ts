/**
 * Live health check of every market-data source the server can fail over between.
 *
 *   pnpm --filter uniswap-agent-mcp check:sources        (root: pnpm check:sources)
 *
 * For each source it runs the cheapest real request and prints OK / DEGRADED / DOWN with the
 * reason, e.g. the official subgraph's `hasIndexingErrors` flag (the 2026-10-31 outage cause).
 * Read-only. Exit code 1 only if no source can serve a capability.
 */
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { MAINNET_CHAIN_ID, NATIVE_ADDRESS, getChain, requireChainAddress } from '../src/chains.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type ToolDeps } from '../src/context.js';
import { createLogger } from '../src/logger.js';

type Status = 'OK' | 'DEGRADED' | 'DOWN' | 'OFF';
interface Check {
  source: string;
  serves: string;
  status: Status;
  detail: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ms: Date.now() - t };
  }
}

export async function checkSources(deps: ToolDeps): Promise<Check[]> {
  const usdc = requireChainAddress(MAINNET_CHAIN_ID, 'usdc');
  const checks: Check[] = [];

  const official = await timed(() => deps.subgraph.meta());
  const officialData = await timed(() => deps.subgraph.poolsForPair(NATIVE_ADDRESS, usdc, 1));
  checks.push({
    source: 'uniswap-v4-subgraph',
    serves: 'pools, TVL, volume, prices, hooks',
    status: !deps.subgraph.configured
      ? 'OFF'
      : officialData.value
      ? official.value?.hasIndexingErrors
        ? 'DEGRADED'
        : 'OK'
      : 'DOWN',
    detail: !deps.subgraph.configured
      ? 'THEGRAPH_API_KEY not set'
      : officialData.value
      ? `block ${official.value?.blockNumber ?? '?'}${
          official.value?.hasIndexingErrors ? ', hasIndexingErrors=true' : ''
        } (${officialData.ms} ms)`
      : `${
          official.value?.hasIndexingErrors ? 'hasIndexingErrors=true; ' : ''
        }${officialData.error?.slice(0, 160)}`,
  });

  const reg = await timed(() => deps.registry.meta());
  const regData = await timed(() => deps.registry.pairPools(NATIVE_ADDRESS, usdc, 1));
  checks.push({
    source: 'uniswap-v4-pool-registry',
    serves: 'pool & hook discovery',
    status: !deps.registry.configured
      ? 'OFF'
      : regData.value
      ? reg.value?.hasIndexingErrors
        ? 'DEGRADED'
        : 'OK'
      : 'DOWN',
    detail: !deps.registry.configured
      ? 'THEGRAPH_API_KEY or registry id not set'
      : regData.value
      ? `block ${reg.value?.blockNumber ?? '?'}, ${regData.value.length} ETH/USDC pool sample (${
          regData.ms
        } ms)`
      : (regData.error ?? '').slice(0, 160),
  });

  const lp = await timed(() =>
    deps.lp.poolInfo({
      protocol: 'V4',
      chainId: MAINNET_CHAIN_ID as never,
      poolParameters: {
        tokenAddressA: NATIVE_ADDRESS,
        tokenAddressB: usdc,
        fee: 500,
        tickSpacing: 10,
      },
    })
  );
  checks.push({
    source: 'uniswap-lp-api',
    serves: 'official TVL (reserves), pool metadata',
    status: lp.value ? 'OK' : 'DOWN',
    detail: lp.value
      ? `${lp.value.pools?.length ?? 0} pool(s) (${lp.ms} ms)`
      : (lp.error ?? '').slice(0, 160),
  });

  const reader = deps.reader(MAINNET_CHAIN_ID);
  const archive = await timed(async () => {
    const head = await reader.getBlockNumber();
    const code = await reader.getCode(getChain(MAINNET_CHAIN_ID).stateView, head - 7_200n);
    if (!code || code === '0x')
      throw new Error('no code at a block 24h ago (not an archive node?)');
    return head;
  });
  checks.push({
    source: 'uniswap-v4-stateview',
    serves: 'on-chain historical prices (archive RPC)',
    status: archive.value ? 'OK' : 'DOWN',
    detail: archive.value
      ? `head ${archive.value}, 24h-old state readable (${archive.ms} ms)`
      : (archive.error ?? '').slice(0, 160),
  });
  checks.push({
    source: 'poolmanager-logs',
    serves: 'last-resort hook discovery (RPC eth_getLogs)',
    status: archive.value ? 'OK' : 'DOWN',
    detail: archive.value ? 'mainnet RPC reachable' : 'mainnet RPC unavailable',
  });

  const gecko = await timed(() => deps.gecko.tokenPools(usdc));
  checks.push({
    source: 'geckoterminal',
    serves: 'third-party TVL, volume, OHLCV',
    status: !deps.gecko.enabled ? 'OFF' : gecko.value ? 'OK' : 'DOWN',
    detail: !deps.gecko.enabled
      ? 'GECKOTERMINAL_ENABLED=false'
      : gecko.value
      ? `${gecko.value.length} USDC pools (${gecko.ms} ms)`
      : (gecko.error ?? '').slice(0, 160),
  });
  return checks;
}

const isMain = process.argv[1] ? /check-sources\.ts$/.test(process.argv[1]) : false;
if (isMain) {
  const envPath = process.env.DOTENV_PATH ?? (existsSync('../../.env') ? '../../.env' : '.env');
  loadDotenv({ path: envPath, quiet: true, override: false });
  const deps = createDeps(loadConfig({ LOG_LEVEL: 'error', ...process.env }), {
    log: createLogger('error'),
  });
  const checks = await checkSources(deps);
  for (const c of checks) {
    process.stdout.write(
      `${c.status.padEnd(9)}${c.source.padEnd(27)}${c.serves}\n         ${c.detail}\n`
    );
  }
  const up = (name: string) =>
    checks.find((c) => c.source === name)?.status === 'OK' ||
    checks.find((c) => c.source === name)?.status === 'DEGRADED';
  const capabilities: [string, string[]][] = [
    ['pool listing / TVL', ['uniswap-v4-subgraph', 'uniswap-v4-pool-registry', 'geckoterminal']],
    ['price history', ['uniswap-v4-subgraph', 'uniswap-v4-stateview', 'geckoterminal']],
    ['hook discovery', ['uniswap-v4-subgraph', 'uniswap-v4-pool-registry', 'poolmanager-logs']],
  ];
  process.stdout.write('\n');
  let broken = 0;
  for (const [capability, chain] of capabilities) {
    const served = chain.find((s) => checks.find((c) => c.source === s)?.status === 'OK');
    if (!served && !chain.some(up)) broken += 1;
    process.stdout.write(`${capability.padEnd(20)} → ${served ?? 'NO HEALTHY SOURCE'}\n`);
  }
  process.exit(broken ? 1 : 0);
}
