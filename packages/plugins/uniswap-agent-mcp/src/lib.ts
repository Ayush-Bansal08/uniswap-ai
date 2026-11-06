/** Library entry: embed the server, reuse the schemas, or call helpers directly. */
export * from './schemas.js';
export { createServer, createMcpServer, runTool, SERVER_NAME, SERVER_VERSION } from './server.js';
export { createDeps, type ToolDeps, type DepsOverrides } from './context.js';
export { loadConfig, ConfigSchema, ConfigError, type Config } from './config.js';
export { createMcpHttpServer, RateLimiter } from './transport/http.js';
export { CHAINS, getChain, NATIVE_ADDRESS } from './chains.js';
export { McpToolError } from './errors.js';
export { decodeHookPermissions, permissionsBitmap, PERMISSION_RISK } from './hooks/permissions.js';
export { computeHookScore, HOOK_BAND_THRESHOLDS, PENALTIES } from './hooks/score.js';
export { getReferencePriceUsd } from './services/prices.js';
export { TOOLS } from './tools/index.js';
export type { ChainReader } from './clients/rpc.js';
