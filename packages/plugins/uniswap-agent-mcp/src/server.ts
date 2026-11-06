/**
 * createServer — an McpServer with all 16 tools registered. Each tool returns its validated
 * output as `structuredContent` plus a concise text summary; failures are MCP tool errors
 * (`isError: true`) whose text is `{"error":{"code","message","retryable"}}`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createDeps, type DepsOverrides, type ToolDeps } from './context.js';
import type { Config } from './config.js';
import { toToolError } from './errors.js';
import { BuildResultSchema, checkBuildResult } from './schemas.js';
import { TOOLS } from './tools/index.js';
import type { ToolDefinition } from './tools/define.js';

export const SERVER_NAME = 'uniswap-agent-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Uniswap tools for agents. Read tools return market data; build tools return UNSIGNED transactions only —',
  'this server never holds keys, never signs and never broadcasts. Build results are READY (steps to sign',
  'and send in order) or NEEDS_SIGNATURE (run preSteps, sign signature.typedData, then call the same tool',
  'again with the same arguments plus resumeToken and signature within 120 s). Amounts are strings:',
  '`raw` in base units, `decimal` in human units. USD values come from Ethereum-mainnet reference quotes.',
].join(' ');

export function toolResult(def: ToolDefinition, output: unknown): CallToolResult {
  const parsed = def.output.parse(output) as Record<string, unknown>;
  if (def.kind === 'build') {
    const problems = checkBuildResult(BuildResultSchema.parse(parsed));
    if (problems.length) throw new Error(`Inconsistent build result: ${problems.join('; ')}`);
  }
  return {
    content: [{ type: 'text', text: def.summarize(parsed) }],
    structuredContent: parsed,
  };
}

export function errorResult(err: unknown): CallToolResult {
  const error = toToolError(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: error.toBody() }) }],
  };
}

export async function runTool(
  def: ToolDefinition,
  args: unknown,
  deps: ToolDeps
): Promise<CallToolResult> {
  const started = deps.now();
  try {
    const output = await def.handler(args as never, deps);
    const result = toolResult(def, output);
    deps.log.info('tool ok', { tool: def.name, ms: deps.now() - started });
    return result;
  } catch (err) {
    const error = toToolError(err);
    deps.log.warn('tool error', {
      tool: def.name,
      code: error.code,
      retryable: error.retryable,
      ms: deps.now() - started,
      message: error.message,
    });
    return errorResult(error);
  }
}

/** Register every tool on a fresh McpServer bound to the given dependencies. */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: { listChanged: false } } }
  );
  // A narrow signature for registerTool: the SDK's generics infer types from the schemas, which
  // explodes (TS2589) when the host resolves a different zod major for the SDK than for us (e.g.
  // zod 4 for the SDK, zod 3 here). At runtime the SDK accepts both, and outputs are re-validated.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: unknown;
      outputSchema: unknown;
      annotations: Record<string, unknown>;
    },
    cb: (args: unknown) => Promise<CallToolResult>
  ) => void;
  for (const def of TOOLS) {
    register(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        outputSchema: def.output,
        annotations: {
          title: def.title,
          // Build tools only return unsigned transactions: nothing changes on-chain or here.
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: def.kind !== 'build',
          openWorldHint: def.kind !== 'plan',
        },
      },
      (args: unknown) => runTool(def, args, deps)
    );
  }
  return server;
}

/** Convenience: build dependencies from config and return a ready McpServer. */
export function createServer(
  config: Config,
  overrides: DepsOverrides = {}
): { server: McpServer; deps: ToolDeps } {
  const deps = createDeps(config, overrides);
  return { server: createMcpServer(deps), deps };
}
