#!/usr/bin/env node
/**
 * CLI entry: `uniswap-agent-mcp --transport http|stdio [--port 3002] [--host 0.0.0.0]`.
 *   http  — streamable HTTP on /mcp (bearer MCP_AUTH_TOKEN), for backends
 *   stdio — for Claude Code / Cursor (logs go to stderr; stdout is the protocol)
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as loadDotenv } from 'dotenv';
import { ConfigError, loadConfig, resolvePort } from './config.js';
import { createDeps } from './context.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { createMcpHttpServer } from './transport/http.js';

function findEnvFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const { values } = parseArgs({
  options: {
    transport: { type: 'string', default: 'stdio' },
    port: { type: 'string' },
    host: { type: 'string' },
    'env-file': { type: 'string' },
  },
  allowPositionals: false,
});

// Local development: load the nearest .env (real environment variables always win).
if (process.env.NODE_ENV !== 'production') {
  const envFile = values['env-file'] ?? findEnvFile(process.cwd());
  if (envFile) loadDotenv({ path: envFile, quiet: true, override: false });
}

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`\n[${SERVER_NAME}] Refusing to start.\n${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
}

const deps = createDeps(config);
const transport = values.transport;

if (transport === 'stdio') {
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());
  deps.log.info(`${SERVER_NAME} ${SERVER_VERSION} on stdio`, {
    executionChainId: config.EXECUTION_CHAIN_ID,
  });
} else if (transport === 'http') {
  if (!config.MCP_AUTH_TOKEN) {
    process.stderr.write(
      `\n[${SERVER_NAME}] Refusing to start: MCP_AUTH_TOKEN is required for --transport http.\n\n`
    );
    process.exit(1);
  }
  const port = resolvePort(config, values.port ? Number(values.port) : undefined);
  const host = values.host ?? config.MCP_HOST;
  const http = createMcpHttpServer({
    deps,
    authToken: config.MCP_AUTH_TOKEN,
    rateLimitPerMinute: config.MCP_RATE_LIMIT_PER_MIN,
  });
  http.listen(port, host, () => {
    deps.log.info(`${SERVER_NAME} ${SERVER_VERSION} on http://${host}:${port}/mcp`, {
      executionChainId: config.EXECUTION_CHAIN_ID,
    });
  });
  const shutdown = () => http.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} else {
  process.stderr.write(`Unknown --transport "${transport}" (use http or stdio)\n`);
  process.exit(2);
}
