/**
 * Test harness: a fake fetch (route table + call log) for every HTTP API, a fake ChainReader
 * for every RPC read, and a deps factory. No test touches the network.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Address, Hex } from 'viem';
import { loadConfig, type Config } from '../src/config.js';
import { createDeps, type ToolDeps } from '../src/context.js';
import type {
  ChainReader,
  Erc20Metadata,
  InitializeLog,
  PoolKeyOnChain,
  Slot0,
} from '../src/clients/rpc.js';
import { silentLogger } from '../src/logger.js';
import { runTool } from '../src/server.js';
import { TOOLS } from '../src/tools/index.js';
import type { ToolErrorBody, ToolName } from '../src/schemas.js';

export const SEPOLIA = 11155111;
export const MAINNET = 1;
export const ETH: Address = '0x0000000000000000000000000000000000000000';
export const SEPOLIA_USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const MAINNET_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const SEPOLIA_UR: Address = '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3';
export const SEPOLIA_PM: Address = '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4';
export const SEPOLIA_STATE_VIEW: Address = '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C';
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const SWAPPER: Address = '0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421';
export const OTHER: Address = '0x1111111111111111111111111111111111111111';
export const TRADE = 'https://trade-api.gateway.uniswap.org/v1';
export const LP = 'https://liquidity.api.uniswap.org';
export const GRAPH = 'https://gateway.thegraph.com/api';

export const NOW = Date.parse('2026-11-06T12:00:00.000Z');

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  UNISWAP_API_KEY: 'test-uniswap-key',
  EXECUTION_CHAIN_ID: String(SEPOLIA),
  EXECUTION_RPC_URL: 'http://sepolia.rpc.invalid',
  MAINNET_RPC_URL: 'http://mainnet.rpc.invalid',
  THEGRAPH_API_KEY: 'test-graph-key',
  MCP_AUTH_TOKEN: 'test-mcp-auth-token-0123456789abcdef',
  MCP_RESUME_SECRET: 'test-resume-secret-0123456789abcdef0123456789',
  LOG_LEVEL: 'silent',
};

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (
  call: RecordedCall
) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes: {
    method: string;
    match: (url: string) => boolean;
    respond: Responder;
  }[] = [];

  on(
    method: string,
    url: string | RegExp | ((url: string) => boolean),
    respond: Responder | { status?: number; body: unknown }
  ): this {
    const match =
      typeof url === 'string'
        ? (u: string) => u.split('?')[0] === url
        : url instanceof RegExp
        ? (u: string) => url.test(u)
        : url;
    this.routes.unshift({
      method,
      match,
      respond: typeof respond === 'function' ? respond : () => respond,
    });
    return this;
  }

  callsTo(urlPart: string): RecordedCall[] {
    return this.calls.filter((c) => c.url.includes(urlPart));
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headersInit = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers: Record<string, string> = {};
    new Headers(headersInit).forEach((v, k) => (headers[k] = v));
    const rawBody =
      init?.body ??
      (input instanceof Request && input.body ? await input.clone().text() : undefined);
    let body: unknown = rawBody;
    if (typeof rawBody === 'string' && rawBody.length) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call = { method, url, headers, body };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && r.match(url));
    if (!route)
      return new Response(JSON.stringify({ errorCode: 'NoFixture', detail: `${method} ${url}` }), {
        status: 599,
      });
    const { status = 200, body: out } = await route.respond(call);
    return new Response(JSON.stringify(out), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Fake chain reader
// ---------------------------------------------------------------------------

export class FakeReader implements ChainReader {
  blockNumber = 7_000_000n;
  balances = new Map<string, bigint>();
  erc20 = new Map<string, bigint>();
  metadataByToken = new Map<string, Erc20Metadata>();
  code = new Map<string, Hex>();
  storage = new Map<string, Hex>();
  owners = new Map<string, Address>();
  slot0 = new Map<string, Slot0>();
  liquidity = new Map<string, bigint>();
  positions = new Map<
    string,
    { poolKey: PoolKeyOnChain; info: bigint; liquidity: bigint; owner: Address }
  >();
  poolKeys = new Map<string, PoolKeyOnChain>();
  feeState: Awaited<ReturnType<ChainReader['getPositionFeeState']>> | null = null;
  initializeLogs: InitializeLog[] = [];
  getLogsHook: ((from: bigint, to: bigint) => void) | null = null;
  quoteResult: { amount: bigint; gasEstimate: bigint } | Error = { amount: 0n, gasEstimate: 0n };
  timestamps = (block: bigint) => Math.floor(NOW / 1000) - Number(this.blockNumber - block) * 12;
  calls: string[] = [];

  constructor(readonly chainId: number) {}

  async getBlockNumber() {
    return this.blockNumber;
  }
  async getBlockTimestamp(blockNumber: bigint) {
    return this.timestamps(blockNumber);
  }
  async getBalance(address: Address) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async getCode(address: Address, _block?: bigint) {
    return this.code.get(address.toLowerCase());
  }
  async getStorageAt(address: Address, slot: Hex) {
    return (
      this.storage.get(`${address.toLowerCase()}:${slot}`) ??
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  }
  async erc20Metadata(tokens: readonly Address[]) {
    return tokens.map(
      (t) =>
        this.metadataByToken.get(t.toLowerCase()) ?? { symbol: null, name: null, decimals: null }
    );
  }
  async erc20Balances(owner: Address, tokens: readonly Address[]) {
    this.calls.push('erc20Balances');
    return tokens.map((t) => this.erc20.get(`${owner.toLowerCase()}:${t.toLowerCase()}`) ?? 0n);
  }
  async readOwner(address: Address) {
    return this.owners.get(address.toLowerCase()) ?? null;
  }
  async quoteExactSingle() {
    this.calls.push('quoteExactSingle');
    if (this.quoteResult instanceof Error) throw this.quoteResult;
    return this.quoteResult;
  }
  /** Historical slot0 by block (archive reads); falls back to the current value. */
  slot0At: ((poolId: string, block: bigint) => Slot0 | Error) | null = null;
  async getSlot0(_sv: Address, poolId: Hex, blockNumber?: bigint) {
    if (blockNumber !== undefined && this.slot0At) {
      const r = this.slot0At(poolId.toLowerCase(), blockNumber);
      if (r instanceof Error) throw r;
      return r;
    }
    const s = this.slot0.get(poolId.toLowerCase());
    return s ?? { sqrtPriceX96: 0n, tick: 0, protocolFee: 0, lpFee: 0 };
  }
  async getLiquidity(_sv: Address, poolId: Hex) {
    return this.liquidity.get(poolId.toLowerCase()) ?? 0n;
  }
  async getPositionFeeState() {
    if (!this.feeState) throw new Error('no fee state');
    return this.feeState;
  }
  async getPoolAndPositionInfo(_pm: Address, tokenId: bigint) {
    const p = this.positions.get(tokenId.toString());
    if (!p)
      return {
        poolKey: { currency0: ETH, currency1: ETH, fee: 0, tickSpacing: 0, hooks: ETH },
        info: 0n,
      };
    return { poolKey: p.poolKey, info: p.info };
  }
  async getPositionLiquidity(_pm: Address, tokenId: bigint) {
    return this.positions.get(tokenId.toString())?.liquidity ?? 0n;
  }
  async ownerOf(_pm: Address, tokenId: bigint) {
    return this.positions.get(tokenId.toString())?.owner ?? null;
  }
  async poolKeyById(_pm: Address, poolId: Hex) {
    return this.poolKeys.get(poolId.toLowerCase()) ?? null;
  }
  async getInitializeLogs(_pm: Address, from: bigint, to: bigint) {
    this.getLogsHook?.(from, to);
    return this.initializeLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }
}

// ---------------------------------------------------------------------------
// Deps + tool runner
// ---------------------------------------------------------------------------

export interface Harness {
  deps: ToolDeps;
  http: FakeFetch;
  exec: FakeReader;
  main: FakeReader;
  clock: { now: number };
}

export function harness(envOverrides: Record<string, string | undefined> = {}): Harness {
  const http = new FakeFetch();
  const exec = new FakeReader(SEPOLIA);
  const main = new FakeReader(MAINNET);
  const clock = { now: NOW };
  // Every reader knows the allowlisted tokens' metadata.
  exec.metadataByToken.set(SEPOLIA_USDC.toLowerCase(), {
    symbol: 'USDC',
    name: 'USDC',
    decimals: 6,
  });
  main.metadataByToken.set(MAINNET_USDC.toLowerCase(), {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
  });
  exec.code.set(SEPOLIA_USDC.toLowerCase(), '0x6080604052');
  main.code.set(MAINNET_USDC.toLowerCase(), '0x6080604052');
  // Pool manager has code at every block (deployment-block search → 0).
  const deps = createDeps(testConfig(envOverrides), {
    fetch: http.fetch,
    readers: { [SEPOLIA]: exec, [MAINNET]: main },
    now: () => clock.now,
    log: silentLogger,
    sleep: async () => undefined,
  });
  return { deps, http, exec, main, clock };
}

export function tool(name: ToolName) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

export async function call(h: Harness, name: ToolName, args: unknown): Promise<CallToolResult> {
  const def = tool(name);
  // Same input validation the MCP SDK applies before the handler.
  const parsed = def.input.safeParse(args);
  if (!parsed.success) throw new Error(`Test args invalid for ${name}: ${parsed.error.message}`);
  return runTool(def, parsed.data, h.deps);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index deeply into tool outputs
export async function ok<T = Record<string, any>>(
  h: Harness,
  name: ToolName,
  args: unknown
): Promise<T> {
  const result = await call(h, name, args);
  if (result.isError)
    throw new Error(`Expected success from ${name}, got ${JSON.stringify(result.content)}`);
  expectText(result);
  return result.structuredContent as T;
}

export async function fail(h: Harness, name: ToolName, args: unknown): Promise<ToolErrorBody> {
  const result = await call(h, name, args);
  if (!result.isError)
    throw new Error(
      `Expected an error from ${name}, got ${JSON.stringify(result.structuredContent)}`
    );
  if (result.structuredContent) throw new Error('Errors must not carry structuredContent');
  const text = (result.content[0] as { text: string }).text;
  return (JSON.parse(text) as { error: ToolErrorBody }).error;
}

function expectText(result: CallToolResult) {
  const first = result.content[0] as { type: string; text?: string } | undefined;
  if (!first || first.type !== 'text' || !first.text)
    throw new Error('Tool result must include a text summary');
}

/** Encode a v4-periphery PositionInfo word (poolId prefix | tickUpper | tickLower | hasSubscriber). */
export function encodePositionInfo(poolId: Hex, tickLower: number, tickUpper: number): bigint {
  const u24 = (n: number) => BigInt(n < 0 ? n + 0x1000000 : n);
  const prefix = BigInt(`0x${poolId.slice(2, 52)}`);
  return (prefix << 56n) | (u24(tickUpper) << 32n) | (u24(tickLower) << 8n);
}
