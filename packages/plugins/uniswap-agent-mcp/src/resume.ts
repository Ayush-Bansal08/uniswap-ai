/**
 * resumeToken: an opaque, integrity-protected continuation for NEEDS_SIGNATURE → finalize.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payloadPart)).
 * The payload holds only public data (the Uniswap quote / permit data / request body) — no
 * secrets. It is bound to the tool and to a hash of the caller's original arguments, and it
 * expires after 120 s, so a tampered, replayed-elsewhere or stale token is rejected.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from './cache.js';
import { McpToolError } from './errors.js';

export const RESUME_TTL_MS = 120_000;

export interface ResumeEnvelope<T> {
  v: 1;
  tool: string;
  argsHash: string;
  iat: number;
  exp: number;
  data: T;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function hashArgs(args: Record<string, unknown>): string {
  const { resumeToken: _r, signature: _s, ...rest } = args;
  return createHash('sha256').update(stableStringify(rest)).digest('base64url');
}

export class ResumeTokens {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = RESUME_TTL_MS
  ) {
    if (secret.length < 32) throw new Error('MCP_RESUME_SECRET must be at least 32 characters');
  }

  private sign(payloadPart: string): string {
    return b64url(createHmac('sha256', this.secret).update(payloadPart).digest());
  }

  issue<T>(
    tool: string,
    args: Record<string, unknown>,
    data: T
  ): { token: string; expiresAt: string } {
    const iat = this.now();
    const envelope: ResumeEnvelope<T> = {
      v: 1,
      tool,
      argsHash: hashArgs(args),
      iat,
      exp: iat + this.ttlMs,
      data,
    };
    const payloadPart = b64url(Buffer.from(JSON.stringify(envelope), 'utf8'));
    return {
      token: `${payloadPart}.${this.sign(payloadPart)}`,
      expiresAt: new Date(envelope.exp).toISOString(),
    };
  }

  verify<T>(tool: string, args: Record<string, unknown>, token: string): T {
    const [payloadPart, mac, extra] = token.split('.');
    if (!payloadPart || !mac || extra !== undefined) {
      throw new McpToolError('RESUME_TOKEN_INVALID', 'resumeToken is malformed', {
        retryable: false,
      });
    }
    const expected = Buffer.from(this.sign(payloadPart));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new McpToolError(
        'RESUME_TOKEN_INVALID',
        'resumeToken failed its integrity check (tampered or wrong secret)',
        {
          retryable: false,
        }
      );
    }
    let envelope: ResumeEnvelope<T>;
    try {
      envelope = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf8')
      ) as ResumeEnvelope<T>;
    } catch {
      throw new McpToolError('RESUME_TOKEN_INVALID', 'resumeToken payload is unreadable', {
        retryable: false,
      });
    }
    if (envelope.v !== 1 || envelope.tool !== tool) {
      throw new McpToolError(
        'RESUME_TOKEN_INVALID',
        `resumeToken was issued for ${envelope.tool}, not ${tool}`,
        {
          retryable: false,
        }
      );
    }
    if (envelope.argsHash !== hashArgs(args)) {
      throw new McpToolError(
        'RESUME_TOKEN_INVALID',
        'resumeToken does not match these arguments; send the same arguments as the first call',
        { retryable: false }
      );
    }
    if (this.now() > envelope.exp) {
      throw new McpToolError(
        'RESUME_TOKEN_EXPIRED',
        'resumeToken expired (120 s); call the tool again without it',
        {
          retryable: true,
        }
      );
    }
    return envelope.data;
  }
}
