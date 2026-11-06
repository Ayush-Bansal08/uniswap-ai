/**
 * Dependency container handed to every tool. Production wiring comes from the config; tests
 * inject a fake `fetch` (all HTTP) and fake `ChainReader`s (all RPC), so no network is used.
 */
import { TtlCache } from './cache.js';
import { getChain, MAINNET_CHAIN_ID } from './chains.js';
import { EtherscanClient } from './clients/etherscan.js';
import { GeckoTerminalClient } from './clients/geckoterminal.js';
import { createResilientFetch, type FetchLike } from './clients/http.js';
import { LpApiClient } from './clients/lpApi.js';
import { PoolRegistryClient } from './clients/poolRegistry.js';
import { ViemChainReader, type ChainReader } from './clients/rpc.js';
import { SubgraphClient } from './clients/subgraph.js';
import { TradingApiClient } from './clients/tradingApi.js';
import type { Config } from './config.js';
import { McpToolError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { SourceHealth } from './market/health.js';
import { ResumeTokens } from './resume.js';
import { TokenRegistry, UnsupportedTokenList } from './tokens.js';

export interface ToolDeps {
  config: Config;
  executionChainId: number;
  trading: TradingApiClient;
  lp: LpApiClient;
  subgraph: SubgraphClient;
  /** Fallback v4 pool registry subgraph (Initialize events). */
  registry: PoolRegistryClient;
  /** Third-party fallback for TVL / volume / prices. */
  gecko: GeckoTerminalClient;
  /** Market-data source health (cooldowns after failures). */
  health: SourceHealth;
  etherscan: EtherscanClient;
  tokens: TokenRegistry;
  unsupported: UnsupportedTokenList;
  cache: TtlCache;
  resume: ResumeTokens;
  /** RPC reader for the execution chain or mainnet; throws UNSUPPORTED_CHAIN otherwise. */
  reader(chainId: number): ChainReader;
  now(): number;
  log: Logger;
}

export interface DepsOverrides {
  /** Replaces the network fetch for every HTTP client (retries/timeouts still apply). */
  fetch?: FetchLike;
  readers?: Record<number, ChainReader>;
  now?: () => number;
  log?: Logger;
  /** Retry backoff sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export function createDeps(config: Config, overrides: DepsOverrides = {}): ToolDeps {
  getChain(config.EXECUTION_CHAIN_ID); // fail fast on an unknown execution chain
  const log = overrides.log ?? createLogger(config.LOG_LEVEL);
  const now = overrides.now ?? Date.now;
  const fetch = createResilientFetch({
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    timeoutMs: config.HTTP_TIMEOUT_MS,
    maxRetries: 3,
    onRetry: (info) =>
      log.warn('retrying upstream request', {
        host: new URL(info.url).host,
        path: new URL(info.url).pathname.replace(/\/api\/[^/]+\//, '/api/<key>/'),
        attempt: info.attempt,
        status: info.status,
      }),
  });
  const cache = new TtlCache(5_000, now);

  const readers = new Map<number, ChainReader>();
  const rpcUrls: Record<number, string> = {
    [config.EXECUTION_CHAIN_ID]: config.EXECUTION_RPC_URL,
    [MAINNET_CHAIN_ID]: config.MAINNET_RPC_URL,
  };
  const reader = (chainId: number): ChainReader => {
    const injected = overrides.readers?.[chainId];
    if (injected) return injected;
    const existing = readers.get(chainId);
    if (existing) return existing;
    const url = rpcUrls[chainId];
    if (!url || overrides.readers) {
      throw new McpToolError(
        'UNSUPPORTED_CHAIN',
        `Chain ${chainId} is not available: this server reads the execution chain (${config.EXECUTION_CHAIN_ID}) and Ethereum mainnet (1) only.`,
        { retryable: false }
      );
    }
    const created = new ViemChainReader(chainId, url, { timeoutMs: config.HTTP_TIMEOUT_MS });
    readers.set(chainId, created);
    return created;
  };

  return {
    config,
    executionChainId: config.EXECUTION_CHAIN_ID,
    trading: new TradingApiClient({
      baseUrl: config.UNISWAP_API_BASE_URL,
      apiKey: config.UNISWAP_API_KEY,
      fetch,
      universalRouterVersion: config.UNISWAP_UNIVERSAL_ROUTER_VERSION,
      decisionOrigin: config.UNISWAP_DECISION_ORIGIN,
    }),
    lp: new LpApiClient({
      baseUrl: config.UNISWAP_LP_API_BASE_URL,
      apiKey: config.UNISWAP_API_KEY,
      fetch,
      decisionOrigin: config.UNISWAP_DECISION_ORIGIN,
    }),
    subgraph: new SubgraphClient({
      gatewayUrl: config.THEGRAPH_GATEWAY_URL,
      apiKey: config.THEGRAPH_API_KEY,
      subgraphId: config.UNISWAP_V4_SUBGRAPH_ID,
      fetch,
    }),
    registry: new PoolRegistryClient({
      gatewayUrl: config.THEGRAPH_GATEWAY_URL,
      apiKey: config.THEGRAPH_API_KEY,
      subgraphId: config.UNISWAP_V4_POOL_REGISTRY_SUBGRAPH_ID,
      fetch,
    }),
    gecko: new GeckoTerminalClient({
      baseUrl: config.GECKOTERMINAL_API_URL,
      network: 'eth',
      fetch,
      enabled: config.GECKOTERMINAL_ENABLED,
    }),
    health: new SourceHealth(now, config.MARKET_SOURCE_COOLDOWN_MS),
    etherscan: new EtherscanClient({
      baseUrl: config.ETHERSCAN_API_URL,
      apiKey: config.ETHERSCAN_API_KEY,
      fetch,
    }),
    tokens: new TokenRegistry(config.TOKEN_ALLOWLIST_JSON ?? [], cache, reader),
    unsupported: new UnsupportedTokenList(config.UNSUPPORTED_TOKENS_URL, fetch, cache),
    cache,
    resume: new ResumeTokens(config.MCP_RESUME_SECRET, now),
    reader,
    now,
    log,
  };
}

/** Build tools only target the configured execution testnet (mainnet is read-only). */
export function requireExecutionChain(deps: ToolDeps, chainId: number): void {
  if (chainId !== deps.executionChainId) {
    throw new McpToolError(
      'UNSUPPORTED_CHAIN',
      `Transactions can only be built for the execution chain ${deps.executionChainId}; chain ${chainId} is read-only here.`,
      { retryable: false }
    );
  }
}

/** Read tools serve the execution chain and Ethereum mainnet. */
export function requireReadableChain(deps: ToolDeps, chainId: number): void {
  if (chainId !== deps.executionChainId && chainId !== MAINNET_CHAIN_ID) {
    throw new McpToolError(
      'UNSUPPORTED_CHAIN',
      `Chain ${chainId} is not served. Use the execution chain (${deps.executionChainId}) or Ethereum mainnet (1).`,
      { retryable: false }
    );
  }
}
