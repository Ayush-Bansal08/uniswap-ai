/**
 * Manual live smoke test against the real Uniswap APIs, RPCs and subgraph (prints results).
 *
 *   npm run smoke                                          # in-process server, reads ./.env (or DOTENV_PATH)
 *   npm run smoke -- --http        # against a running server (MCP_URL, MCP_AUTH_TOKEN)
 *   SMOKE_SWAPPER=0x… npm run smoke  # quote/build for your own address
 *
 * Read-only, plus one UNSIGNED build_swap. Nothing is signed or broadcast.
 */
import { parseArgs } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '../src/config.js';
import { createDeps } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import {
  connectHttp,
  connectInProcess,
  coreSteps,
  exitCode,
  extendedSteps,
  REFERENCE_SWAPPER,
  runSmoke,
} from './smoke-lib.js';

const { values } = parseArgs({
  options: { http: { type: 'boolean', default: false }, core: { type: 'boolean', default: false } },
});
loadDotenv({ path: process.env.DOTENV_PATH ?? '.env', quiet: true, override: false });

const config = loadConfig({ LOG_LEVEL: 'warn', ...process.env });
const swapper = process.env.SMOKE_SWAPPER ?? REFERENCE_SWAPPER;
const client = values.http
  ? await connectHttp(
      process.env.MCP_URL ?? 'http://localhost:3002/mcp',
      config.MCP_AUTH_TOKEN ?? ''
    )
  : await connectInProcess(createDeps(config, { log: createLogger('warn') }));

const steps = [
  ...coreSteps(config.EXECUTION_CHAIN_ID, swapper),
  ...(values.core ? [] : extendedSteps(config.EXECUTION_CHAIN_ID, swapper)),
];
process.stdout.write(
  `uniswap-agent-mcp live smoke — execution chain ${config.EXECUTION_CHAIN_ID}, ${
    values.http ? 'HTTP' : 'in-process'
  }\n\n`
);
const results = await runSmoke(client, steps, (line) => process.stdout.write(`${line}\n`));
await client.close();
process.exit(exitCode(steps, results));
