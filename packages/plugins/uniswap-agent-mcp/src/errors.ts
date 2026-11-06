/**
 * Tool errors. Every failure a tool reports carries a stable `code`, a human message and
 * whether retrying can help. They reach MCP clients as `isError: true` results whose text is
 * `{"error":{"code","message","retryable"}}` (no structuredContent, so output schemas stay strict).
 */
import type { ToolErrorBody, ToolErrorCode } from './schemas.js';

const RETRYABLE_BY_DEFAULT: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  'SUBGRAPH_UNAVAILABLE',
  'MARKET_DATA_UNAVAILABLE',
  'RPC_ERROR',
  'RESUME_TOKEN_EXPIRED',
]);

export class McpToolError extends Error {
  override name = 'McpToolError';
  readonly retryable: boolean;

  constructor(
    readonly code: ToolErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.details = options.details;
  }

  readonly details: Record<string, unknown> | undefined;

  toBody(): ToolErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isMcpToolError(value: unknown): value is McpToolError {
  return value instanceof McpToolError;
}

/** Normalise anything thrown inside a tool into an McpToolError (never leaks stack traces). */
export function toToolError(err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new McpToolError('INTERNAL', `Unexpected error: ${message.slice(0, 500)}`, {
    retryable: false,
    cause: err,
  });
}

export const invalidInput = (message: string, details?: Record<string, unknown>) =>
  new McpToolError('INVALID_INPUT', message, { retryable: false, details });
