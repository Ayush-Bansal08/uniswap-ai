/**
 * TxStep construction + validation. Applied to every transaction a build tool returns
 * (PHASE 02 §4; swap-integration "Pre-Broadcast Validation"; LP guide "Transaction validation"):
 *   - `data` is non-empty hex (the only exception: a native ETH TRANSFER, which has no calldata)
 *   - `to` / `from` are valid and returned checksummed
 *   - `chainId` equals the requested chain, `from` equals the requested owner/swapper
 *   - `to` is one of the contracts we expect for that step kind
 *   - never both `maxFeePerGas` and `gasPrice`
 * Calldata is passed through byte-for-byte: it is never modified.
 */
import { getAddress, isAddress, isHex, type Address } from 'viem';
import { McpToolError } from './errors.js';
import type { TxStep } from './schemas.js';

export interface UpstreamTx {
  to?: string | null;
  from?: string | null;
  data?: string | null;
  value?: string | null;
  chainId?: number | string | null;
  gasLimit?: string | null;
  maxFeePerGas?: string | null;
  gasPrice?: string | null;
}

export interface TxExpectations {
  chainId: number;
  from: Address;
  /** Allowed `to` addresses for this step (checksummed or not). Empty = any valid address. */
  allowedTo?: readonly string[];
  /** Native transfers legitimately carry no calldata. */
  allowEmptyData?: boolean;
}

function invalid(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_TX', message, { retryable: false, details });
}

export function validateTx(
  kind: TxStep['kind'],
  description: string,
  tx: UpstreamTx | null | undefined,
  expect: TxExpectations
): TxStep {
  if (!tx) throw invalid(`${kind}: transaction is missing`);
  const data = tx.data ?? '';
  const emptyData = data === '' || data === '0x';
  if (emptyData && !expect.allowEmptyData) {
    throw invalid(`${kind}: transaction data is empty — the quote may have expired; rebuild it.`);
  }
  if (!emptyData && !isHex(data)) throw invalid(`${kind}: transaction data is not valid hex`);
  if (!tx.to || !isAddress(tx.to, { strict: false }))
    throw invalid(`${kind}: invalid "to" address`);
  if (!tx.from || !isAddress(tx.from, { strict: false }))
    throw invalid(`${kind}: invalid "from" address`);
  const to = getAddress(tx.to);
  const from = getAddress(tx.from);
  if (from !== getAddress(expect.from)) {
    throw invalid(`${kind}: "from" ${from} does not match the requested account ${expect.from}`);
  }
  const chainId = Number(tx.chainId);
  if (!Number.isInteger(chainId) || chainId !== expect.chainId) {
    throw invalid(
      `${kind}: chainId ${String(tx.chainId)} does not match requested chain ${expect.chainId}`
    );
  }
  if (expect.allowedTo && expect.allowedTo.length > 0) {
    const allowed = expect.allowedTo.map((a) => getAddress(a));
    if (!allowed.includes(to)) {
      throw invalid(`${kind}: unexpected target contract ${to}`, { allowed });
    }
  }
  if (tx.maxFeePerGas && tx.gasPrice)
    throw invalid(`${kind}: both maxFeePerGas and gasPrice are set`);
  const value = tx.value ?? '0';
  if (!/^\d+$/.test(value)) throw invalid(`${kind}: value must be a wei integer string`);
  const gasLimit = tx.gasLimit && /^\d+$/.test(tx.gasLimit) ? tx.gasLimit : undefined;
  return {
    kind,
    description,
    tx: {
      to,
      from,
      data: emptyData ? '0x' : (data as `0x${string}`),
      value,
      chainId,
      ...(gasLimit ? { gasLimit } : {}),
    },
  };
}
