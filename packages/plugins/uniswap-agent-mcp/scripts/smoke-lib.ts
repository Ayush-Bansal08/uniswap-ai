/**
 * Live smoke-test runner (manual; hits real APIs). Talks to the server through a real MCP
 * client — in-process (InMemoryTransport) or over streamable HTTP against a running server.
 * Read-only plus one unsigned build: nothing is ever signed or broadcast.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolDeps } from '../src/context.js';
import { createMcpServer } from '../src/server.js';

export const REFERENCE_SWAPPER = '0x000000000000000000000000000000000000dEaD';

export interface SmokeStep {
  name: string;
  tool: string;
  args:
    | Record<string, unknown>
    | ((previous: Map<string, unknown>) => Record<string, unknown> | null);
  required: boolean;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  skipped: boolean;
  ms: number;
  summary: string;
}

export async function connectInProcess(deps: ToolDeps): Promise<Client> {
  const server = createMcpServer(deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'uniswap-agent-mcp-smoke', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

export async function connectHttp(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'uniswap-agent-mcp-smoke', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

/** The PHASE 02 smoke: quotes on both chains, new market hooks, and a score for the first hook. */
export function coreSteps(executionChainId: number, swapper = REFERENCE_SWAPPER): SmokeStep[] {
  const quote = (chainId: number) => ({
    chainId,
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    amount: '0.001',
    type: 'EXACT_INPUT',
    swapper,
    slippagePct: 0.5,
  });
  return [
    {
      name: `get_quote ETH→USDC on execution chain ${executionChainId}`,
      tool: 'get_quote',
      args: quote(executionChainId),
      required: true,
    },
    {
      name: 'get_quote ETH→USDC on Ethereum mainnet',
      tool: 'get_quote',
      args: quote(1),
      required: true,
    },
    {
      name: 'list_new_hooks (market, 30 days)',
      tool: 'list_new_hooks',
      args: { scope: 'market', sinceDays: 30, limit: 5 },
      required: true,
    },
    {
      name: 'score_hook on the first market hook',
      tool: 'score_hook',
      args: (prev) => {
        const hooks = (
          prev.get('list_new_hooks') as { hooks?: { hookAddress: string }[] } | undefined
        )?.hooks;
        return hooks?.[0] ? { chainId: 1, hookAddress: hooks[0].hookAddress } : null;
      },
      required: true,
    },
  ];
}

/** Extra coverage for `pnpm --filter uniswap-agent-mcp smoke`. */
export function extendedSteps(executionChainId: number, swapper = REFERENCE_SWAPPER): SmokeStep[] {
  return [
    {
      name: 'get_portfolio',
      tool: 'get_portfolio',
      args: { chainId: executionChainId, address: swapper },
      required: false,
    },
    {
      name: 'check_token USDC',
      tool: 'check_token',
      args: { chainId: executionChainId, token: 'USDC' },
      required: false,
    },
    {
      name: 'compare_pools ETH/USDC',
      tool: 'compare_pools',
      args: { chainId: executionChainId, tokenA: 'ETH', tokenB: 'USDC' },
      required: false,
    },
    {
      name: 'get_price_history ETH 24h',
      tool: 'get_price_history',
      args: { symbol: 'ETH', window: '24h', interval: 'hour' },
      required: false,
    },
    {
      name: 'list_new_hooks (execution, 3 days)',
      tool: 'list_new_hooks',
      args: { scope: 'execution', sinceDays: 3, limit: 5 },
      required: false,
    },
    {
      name: 'plan_trigger take-profit +2%',
      tool: 'plan_trigger',
      args: {
        kind: 'TAKE_PROFIT',
        condition: { type: 'price_change_pct', symbol: 'ETH', pct: 2, from: 'now' },
        actions: [{ type: 'swap_exact_in', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '50%' }],
      },
      required: false,
    },
    {
      name: 'build_swap ETH→USDC (unsigned only)',
      tool: 'build_swap',
      args: {
        chainId: executionChainId,
        swapper,
        tokenIn: 'ETH',
        tokenOut: 'USDC',
        amount: '0.001',
        type: 'EXACT_INPUT',
        slippagePct: 0.5,
      },
      required: false,
    },
  ];
}

export async function runSmoke(
  client: Client,
  steps: SmokeStep[],
  print: (line: string) => void
): Promise<SmokeResult[]> {
  const previous = new Map<string, unknown>();
  const results: SmokeResult[] = [];
  for (const step of steps) {
    const args = typeof step.args === 'function' ? step.args(previous) : step.args;
    if (!args) {
      results.push({
        name: step.name,
        ok: !step.required,
        skipped: true,
        ms: 0,
        summary: 'skipped (no input from the previous step)',
      });
      continue;
    }
    const started = Date.now();
    let ok = false;
    let summary: string;
    try {
      const result = await client.callTool({ name: step.tool, arguments: args });
      const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
      ok = !result.isError;
      summary = text;
      if (ok) previous.set(step.tool, result.structuredContent);
    } catch (err) {
      summary = err instanceof Error ? err.message : String(err);
    }
    results.push({ name: step.name, ok, skipped: false, ms: Date.now() - started, summary });
  }
  for (const r of results) {
    print(
      `${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${
        r.ms
      } ms)\n      ${r.summary.slice(0, 600)}`
    );
  }
  const required = steps.filter((s) => s.required).length;
  const passed = results.filter((r, i) => steps[i]!.required && r.ok).length;
  print(`\n${passed}/${required} required checks passed`);
  return results;
}

export function exitCode(steps: SmokeStep[], results: SmokeResult[]): number {
  return results.some((r, i) => steps[i]!.required && !r.ok) ? 1 : 0;
}
