/**
 * Typed configuration from the environment. Fails fast with every problem listed.
 * Secrets (API keys, MCP_AUTH_TOKEN, MCP_RESUME_SECRET) are only ever read here and never logged.
 */
import { z } from 'zod';
import { AddressSchema } from './schemas.js';

const url = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ''));

export const AllowlistEntrySchema = z.object({
  chainId: z.number().int().positive(),
  address: AddressSchema,
  symbol: z.string().trim().min(1).max(20),
  decimals: z.number().int().min(0).max(255),
  /** Optional mainnet symbol used for USD reference prices (e.g. "ETH" for WETH). */
  referenceSymbol: z.string().trim().min(1).max(20).optional(),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;

const allowlistJson = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.array(AllowlistEntrySchema).max(200));

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Uniswap Developer Platform key (Trading API + LP API). Sent as `x-api-key`. */
  UNISWAP_API_KEY: z.string().min(8),
  UNISWAP_API_BASE_URL: url.default('https://trade-api.gateway.uniswap.org/v1'),
  UNISWAP_LP_API_BASE_URL: url.default('https://liquidity.api.uniswap.org'),
  /**
   * `x-agent-info` decision_origin (swap-integration skill, "Agent Attribution"). There is no
   * default in the skill; we default to `autonomous` because the calling agent may execute
   * within user limits without per-action approval. Set `human_mediated` if every action is
   * approved by a human (e.g. Claude Code with tool confirmations).
   */
  UNISWAP_DECISION_ORIGIN: z.enum(['autonomous', 'human_mediated']).default('autonomous'),
  /** Universal Router version header. 2.0 and 2.1.1 were sunset on 2026-10-21 (supported-chains doc). */
  UNISWAP_UNIVERSAL_ROUTER_VERSION: z.enum(['2.1.2', '2.2.0']).default('2.1.2'),
  EXECUTION_CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  EXECUTION_RPC_URL: url,
  MAINNET_RPC_URL: url,
  THEGRAPH_API_KEY: z.string().min(8).optional(),
  UNISWAP_V4_SUBGRAPH_ID: z
    .string()
    .min(10)
    .default('DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G'),
  THEGRAPH_GATEWAY_URL: url.default('https://gateway.thegraph.com/api'),
  /**
   * Fallback pool registry subgraph (Initialize events only: pools, hooks, fees). Used when the
   * official analytics subgraph is unhealthy. Empty string disables it.
   */
  UNISWAP_V4_POOL_REGISTRY_SUBGRAPH_ID: z
    .string()
    .default('6XvRX3WHSvzBVTiPdF66XSBVbxWuHqijWANbjJxRDyzr'),
  /** Third-party fallback for TVL/volume/prices (GeckoTerminal, no key). */
  GECKOTERMINAL_API_URL: url.default('https://api.geckoterminal.com/api/v2'),
  GECKOTERMINAL_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** How long a failed market-data source is skipped before being retried. */
  MARKET_SOURCE_COOLDOWN_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  ETHERSCAN_API_KEY: z.string().min(8).optional(),
  ETHERSCAN_API_URL: url.default('https://api.etherscan.io/v2/api'),
  UNSUPPORTED_TOKENS_URL: url.default('https://unsupportedtokens.uniswap.org'),
  /** Bearer token required on the HTTP transport. Not needed for stdio. */
  MCP_AUTH_TOKEN: z.string().min(24, 'must be at least 24 characters').optional(),
  /** HMAC key for resumeTokens (NEEDS_SIGNATURE → finalize). */
  MCP_RESUME_SECRET: z.string().min(32, 'must be at least 32 characters'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MCP_HOST: z.string().min(1).default('0.0.0.0'),
  /** Requests per minute per bearer token on the HTTP transport. */
  MCP_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(600),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  /** eth_getLogs block window for PoolManager Initialize scans (halved automatically on errors). */
  LOGS_BLOCK_WINDOW: z.coerce.number().int().min(10).max(100_000).default(5_000),
  TOKEN_ALLOWLIST_JSON: allowlistJson.optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(readonly issues: string[]) {
    super(`Invalid uniswap-agent-mcp configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== '')
  );
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(root)';
        return issue.code === 'invalid_type' && issue.received === 'undefined'
          ? `${key} is required but missing`
          : `${key} ${issue.message}`;
      })
    );
  }
  return parsed.data;
}

/** Port for the HTTP transport: --port flag > MCP_PORT > PORT (Railway) > 3002. */
export function resolvePort(config: Config, flag?: number): number {
  return flag ?? config.MCP_PORT ?? config.PORT ?? 3002;
}
