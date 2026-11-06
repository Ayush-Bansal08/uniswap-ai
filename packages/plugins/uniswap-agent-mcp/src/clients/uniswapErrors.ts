/** Maps Uniswap Trading/LP API failures to McpToolError codes. */
import { McpToolError } from '../errors.js';
import { HttpNetworkError, HttpTimeoutError } from './http.js';

interface UniswapErrorBody {
  errorCode?: string;
  detail?: string;
  error?: string;
  message?: string;
  code?: string;
  requestId?: string;
}

function asBody(value: unknown): UniswapErrorBody {
  return value && typeof value === 'object' ? (value as UniswapErrorBody) : {};
}

export function mapUniswapError(api: string, status: number, raw: unknown): McpToolError {
  const body = asBody(raw);
  const errorCode = body.errorCode ?? body.code ?? body.error ?? `HTTP_${status}`;
  const detail = (body.detail ?? body.message ?? '').slice(0, 400);
  const message = `${api}: ${errorCode}${detail ? ` — ${detail}` : ''}`;
  const details = {
    api,
    status,
    errorCode,
    ...(body.requestId ? { requestId: body.requestId } : {}),
  };

  if (status === 429) return new McpToolError('RATE_LIMITED', message, { details });
  if (status === 401 || status === 403)
    return new McpToolError('UPSTREAM_ERROR', `${message} (check UNISWAP_API_KEY)`, {
      retryable: false,
      details,
    });
  if (errorCode === 'UpstreamTimeoutError')
    return new McpToolError('UPSTREAM_TIMEOUT', message, { details });
  if (errorCode === 'UnsupportedChainError')
    return new McpToolError('UNSUPPORTED_CHAIN', message, { retryable: false, details });
  if (
    status === 404 &&
    [
      'NoRouteFoundError',
      'QuoteAmountTooLowError',
      'ResourceNotFound',
      'UnsupportedTokenError',
    ].includes(errorCode)
  )
    return new McpToolError('NO_ROUTE', message, { retryable: false, details });
  if (status === 404) return new McpToolError('NO_ROUTE', message, { retryable: false, details });
  if (status >= 400 && status < 500)
    return new McpToolError('INVALID_INPUT', message, { retryable: false, details });
  return new McpToolError('UPSTREAM_ERROR', message, { retryable: true, details });
}

export function mapTransportError(api: string, err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  if (err instanceof HttpTimeoutError)
    return new McpToolError('UPSTREAM_TIMEOUT', `${api}: ${err.message}`);
  if (err instanceof HttpNetworkError)
    return new McpToolError('UPSTREAM_ERROR', `${api}: ${err.message}`);
  return new McpToolError(
    'UPSTREAM_ERROR',
    `${api}: ${err instanceof Error ? err.message : String(err)}`
  );
}
