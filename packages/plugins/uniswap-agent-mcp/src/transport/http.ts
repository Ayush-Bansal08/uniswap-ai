/**
 * Streamable HTTP transport (stateless) on POST /mcp with `Authorization: Bearer <MCP_AUTH_TOKEN>`
 * and a per-token rate limit. A fresh McpServer + transport is created per request (the SDK's
 * stateless pattern); tool dependencies (caches, clients) are shared. GET /health is public.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolDeps } from '../context.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from '../server.js';

const MAX_BODY_BYTES = 1_048_576;

export interface HttpServerOptions {
  deps: ToolDeps;
  authToken: string;
  /** Requests per minute per bearer token. */
  rateLimitPerMinute: number;
  path?: string;
}

/** Fixed-window limiter keyed by a hash of the bearer token (never the token itself). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  hit(key: string): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.prune(t);
      return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - 1 };
    }
    w.count += 1;
    const allowed = w.count <= this.limit;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.ceil((w.start + this.windowMs - t) / 1000),
      remaining: Math.max(0, this.limit - w.count),
    };
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
) {
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

export function createMcpHttpServer(options: HttpServerOptions): Server {
  const path = options.path ?? '/mcp';
  const expected = digest(options.authToken);
  const limiter = new RateLimiter(options.rateLimitPerMinute, 60_000, options.deps.now);
  const log = options.deps.log;

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        executionChainId: options.deps.executionChainId,
      });
    }
    if (url.pathname !== path) return json(res, 404, { error: 'Not found' });

    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const given = match?.[1] ? digest(match[1].trim()) : null;
    if (!given || !timingSafeEqual(given, expected)) {
      return jsonRpcError(res, 401, -32001, 'Unauthorized: missing or invalid bearer token', {
        'www-authenticate': 'Bearer',
      });
    }
    const rate = limiter.hit(given.toString('hex'));
    if (!rate.allowed) {
      return jsonRpcError(res, 429, -32002, 'Rate limit exceeded', {
        'retry-after': String(rate.retryAfterSeconds),
      });
    }
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream (GET) or session teardown (DELETE).
      return jsonRpcError(res, 405, -32000, 'Method not allowed', { allow: 'POST' });
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return jsonRpcError(res, status, -32700, err instanceof Error ? err.message : 'Bad request');
    }

    const server = createMcpServer(options.deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error('mcp request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });
}
