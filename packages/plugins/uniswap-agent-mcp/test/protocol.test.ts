/**
 * MCP protocol: the real server over streamable HTTP (in-process, ephemeral port) and stdio-style
 * in-memory transport. listTools returns exactly the 16 documented tools; auth is required.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/schemas.js';
import { createMcpServer } from '../src/server.js';
import { createMcpHttpServer, RateLimiter } from '../src/transport/http.js';
import { mainnetEthPriceQuote } from './fixtures.js';
import { harness, TEST_ENV, TRADE } from './helpers.js';

const TOKEN = TEST_ENV.MCP_AUTH_TOKEN!;

describe('streamable HTTP transport', () => {
  const h = harness();
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createMcpHttpServer({ deps: h.deps, authToken: TOKEN, rateLimitPerMinute: 1000 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(token = TOKEN) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    );
    return client;
  }

  it('lists exactly the 16 documented tools with input and output schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(tools).toHaveLength(16);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type).toBe('object');
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();
  });

  it('serves a tool call end to end with structuredContent and a text summary', async () => {
    const client = await connect();
    h.http.on('POST', `${TRADE}/quote`, { body: mainnetEthPriceQuote() });
    const result = await client.callTool({
      name: 'get_quote',
      arguments: {
        chainId: 1,
        tokenIn: 'ETH',
        tokenOut: 'USDC',
        amount: '1',
        type: 'EXACT_INPUT',
        swapper: '0x000000000000000000000000000000000000dEaD',
      },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { amountOut: { decimal: string } }).amountOut.decimal).toBe(
      '3247.18'
    );
    expect((result.content as { text: string }[])[0]!.text).toMatch(/1 ETH → 3247\.18 USDC/);
    await client.close();
  });

  it('returns input validation failures as tool errors', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'get_quote',
      arguments: { chainId: 1, tokenIn: 'ETH' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/Input validation error/);
    await client.close();
  });

  it('rejects requests without a valid bearer token', async () => {
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    };
    const none = await fetch(url, init);
    expect(none.status).toBe(401);
    const wrong = await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    await expect(connect('wrong-token-wrong-token-wrong')).rejects.toThrow();
  });

  it('exposes an unauthenticated /health and 404s other paths', async () => {
    const base = url.replace('/mcp', '');
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, executionChainId: 11155111 });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('rejects GET on /mcp (stateless: no SSE stream)', async () => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });
});

describe('rate limiting per bearer token', () => {
  it('allows up to the limit per window, then 429 with retry-after', async () => {
    const h = harness();
    const server = createMcpHttpServer({ deps: h.deps, authToken: TOKEN, rateLimitPerMinute: 2 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const post = () =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    expect((await post()).status).not.toBe(429);
    expect((await post()).status).not.toBe(429);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('RateLimiter resets after the window', () => {
    let t = 0;
    const limiter = new RateLimiter(1, 1000, () => t);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
    t = 1000;
    expect(limiter.hit('a').allowed).toBe(true);
  });
});

describe('in-memory (stdio-equivalent) transport', () => {
  it('lists 16 tools', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    expect((await client.listTools()).tools).toHaveLength(16);
    await client.close();
  });
});
