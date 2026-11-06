/**
 * Normalise Uniswap permit payloads into viem-ready EIP-712 typed data.
 *
 * - Trading API `permitData` ({ domain, types, values }) is already viem-shaped.
 * - LP API `v4BatchPermitData` is proto-encoded (lp-integration skill "v4 permit"):
 *   `domain.chainId` may be the chain enum name (e.g. "UNICHAIN") and each `types` entry may be
 *   wrapped as `{ fields: [...] }`. We fix both for signing; the ORIGINAL object is what goes
 *   back to the API (kept in the resumeToken).
 */
import { McpToolError } from '../errors.js';
import type { SignatureRequest } from '../schemas.js';

type Field = { name: string; type: string };

function asFields(value: unknown): Field[] | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { fields?: unknown }).fields)
    ? (value as { fields: unknown[] }).fields
    : null;
  if (!list) return null;
  const fields = list.filter(
    (f): f is Field =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as Field).name === 'string' &&
      typeof (f as Field).type === 'string'
  );
  return fields.length === list.length ? fields.map((f) => ({ name: f.name, type: f.type })) : null;
}

/** The primary type is the one no other struct references. */
export function derivePrimaryType(types: Record<string, Field[]>): string {
  const names = Object.keys(types);
  const referenced = new Set(
    Object.values(types).flatMap((fields) => fields.map((f) => f.type.replace(/\[\d*\]$/, '')))
  );
  const roots = names.filter((n) => !referenced.has(n));
  if (roots.length !== 1) {
    throw new McpToolError(
      'UPSTREAM_ERROR',
      `Cannot determine the EIP-712 primary type (candidates: ${roots.join(', ') || 'none'})`,
      {
        retryable: false,
      }
    );
  }
  return roots[0]!;
}

export function normalizePermit(
  kind: SignatureRequest['kind'],
  permit: { domain?: unknown; types?: unknown; values?: unknown },
  chainId: number
): SignatureRequest {
  if (!permit.domain || !permit.types || !permit.values) {
    throw new McpToolError(
      'UPSTREAM_ERROR',
      'Permit data from Uniswap is incomplete (domain/types/values)',
      {
        retryable: true,
      }
    );
  }
  const types: Record<string, Field[]> = {};
  for (const [name, value] of Object.entries(permit.types as Record<string, unknown>)) {
    if (name === 'EIP712Domain') continue; // viem derives the domain type itself
    const fields = asFields(value);
    if (!fields) {
      throw new McpToolError('UPSTREAM_ERROR', `Permit type "${name}" has an unexpected shape`, {
        retryable: false,
      });
    }
    types[name] = fields;
  }
  const domain = { ...(permit.domain as Record<string, unknown>) };
  if (domain.chainId !== undefined && !/^\d+$/.test(String(domain.chainId))) {
    domain.chainId = chainId; // proto enum name ("SEPOLIA") → numeric id
  } else if (domain.chainId !== undefined) {
    domain.chainId = Number(domain.chainId);
  }
  return {
    kind,
    typedData: {
      domain,
      types,
      primaryType: derivePrimaryType(types),
      message: permit.values as Record<string, unknown>,
    },
  };
}
