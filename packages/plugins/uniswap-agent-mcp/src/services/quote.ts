/**
 * Classic (AMM) quotes through the Trading API `/quote` (swap-integration skill, Step 2).
 * We restrict `protocols` to V2/V3/V4 so routing is always CLASSIC (never UniswapX), which
 * the spec only allows together with `routingPreference: BEST_PRICE`.
 */
import { getAddress, type Address } from 'viem';
import { amountOf } from '../amounts.js';
import { cacheKey, TTL } from '../cache.js';
import type { ClassicQuote, QuoteRequest, QuoteResponse, Schemas } from '../clients/tradingApi.js';
import type { ToolDeps } from '../context.js';
import { McpToolError } from '../errors.js';
import { isZeroHook } from '../hooks/permissions.js';
import type { GetQuoteOutput, TokenInfo } from '../schemas.js';

/** Quotes go stale fast (skill "Quote Freshness": typically 30 s). */
export const QUOTE_FRESHNESS_MS = 30_000;
/** Neutral swapper for reference-price quotes (no balance/approval needed for /quote). */
export const REFERENCE_SWAPPER: Address = '0x000000000000000000000000000000000000dEaD';

export interface ClassicQuoteParams {
  chainId: number;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountRaw: bigint;
  type: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  swapper: Address;
  slippagePct?: number;
  recipient?: Address;
}

/** Slippage: percentage with at most two decimals (spec `slippageTolerance` pattern). */
export function normalizeSlippage(pct: number): number {
  return Math.round(pct * 100) / 100;
}

export function buildQuoteRequest(p: ClassicQuoteParams): QuoteRequest {
  if (p.amountRaw <= 0n) {
    throw new McpToolError('INVALID_INPUT', 'Amount must be greater than zero', {
      retryable: false,
    });
  }
  const request: QuoteRequest = {
    type: p.type,
    amount: p.amountRaw.toString(),
    tokenInChainId: p.chainId as Schemas['ChainId'],
    tokenOutChainId: p.chainId as Schemas['ChainId'],
    tokenIn: p.tokenIn.address,
    tokenOut: p.tokenOut.address,
    swapper: p.swapper,
    protocols: ['V2', 'V3', 'V4'],
    routingPreference: 'BEST_PRICE',
  };
  if (p.slippagePct !== undefined) request.slippageTolerance = normalizeSlippage(p.slippagePct);
  if (p.recipient && getAddress(p.recipient) !== getAddress(p.swapper))
    request.recipient = p.recipient;
  return request;
}

export async function fetchClassicQuote(
  deps: ToolDeps,
  p: ClassicQuoteParams,
  options: { cache?: boolean } = {}
): Promise<{ response: QuoteResponse; quote: ClassicQuote }> {
  const body = buildQuoteRequest(p);
  const run = () => deps.trading.quote(body);
  const response = options.cache
    ? await deps.cache.wrap(cacheKey('quote', body), TTL.quote, run)
    : await run();
  if (response.routing !== 'CLASSIC') {
    throw new McpToolError(
      'UNSUPPORTED_ROUTING',
      `The Trading API returned routing ${response.routing}; only CLASSIC (AMM) routes are supported.`,
      { retryable: false, details: { routing: response.routing } }
    );
  }
  return { response, quote: response.quote as ClassicQuote };
}

type RouteHop = NonNullable<ClassicQuote['route']>[number][number];

function parseRoute(quote: ClassicQuote): GetQuoteOutput['route'] {
  const pools: GetQuoteOutput['route']['pools'] = [];
  for (const path of quote.route ?? []) {
    for (const hop of path as RouteHop[]) {
      const h = hop as {
        type?: string;
        address?: string;
        fee?: string | number;
        tickSpacing?: string | number;
        hooks?: string;
        tokenIn?: { address?: string };
        tokenOut?: { address?: string };
      };
      const protocol = h.type === 'v4-pool' ? 'V4' : h.type === 'v3-pool' ? 'V3' : 'V2';
      const tokenIn = h.tokenIn?.address;
      const tokenOut = h.tokenOut?.address;
      if (!tokenIn || !tokenOut || !h.address) continue;
      pools.push({
        protocol,
        poolRef: h.address,
        tokenIn: getAddress(tokenIn),
        tokenOut: getAddress(tokenOut),
        fee: h.fee !== undefined && h.fee !== null ? Number(h.fee) : null,
        tickSpacing:
          h.tickSpacing !== undefined && h.tickSpacing !== null ? Number(h.tickSpacing) : null,
        hooks: protocol === 'V4' && h.hooks ? getAddress(h.hooks) : null,
      });
    }
  }
  const hooks = [
    ...new Set(pools.map((pl) => pl.hooks).filter((x): x is Address => !!x && !isZeroHook(x))),
  ];
  return { summary: quote.routeString ?? null, pools, hooks };
}

/** Normalise a CLASSIC quote into the tool's output shape. */
export function normalizeQuote(
  deps: ToolDeps,
  p: ClassicQuoteParams,
  response: QuoteResponse,
  quote: ClassicQuote
): GetQuoteOutput {
  const amountInRaw = BigInt(quote.input?.amount ?? (p.type === 'EXACT_INPUT' ? p.amountRaw : 0n));
  const amountOutRaw = BigInt(
    quote.output?.amount ?? (p.type === 'EXACT_OUTPUT' ? p.amountRaw : 0n)
  );
  const slippage = quote.slippage ?? p.slippagePct ?? null;
  const bps = slippage !== null ? BigInt(Math.round(slippage * 100)) : null;

  let minAmountOut: GetQuoteOutput['minAmountOut'] = null;
  let maxAmountIn: GetQuoteOutput['maxAmountIn'] = null;
  if (p.type === 'EXACT_INPUT') {
    const explicit = quote.output?.minimumAmount;
    const computed = bps !== null ? (amountOutRaw * (10_000n - bps)) / 10_000n : null;
    const value = explicit ? BigInt(explicit) : computed;
    if (value !== null) minAmountOut = amountOf(value, p.tokenOut.decimals);
  } else {
    const explicit = quote.input?.maximumAmount;
    const computed = bps !== null ? (amountInRaw * (10_000n + bps) + 9_999n) / 10_000n : null;
    const value = explicit ? BigInt(explicit) : computed;
    if (value !== null) maxAmountIn = amountOf(value, p.tokenIn.decimals);
  }

  const now = deps.now();
  return {
    chainId: p.chainId,
    routing: 'CLASSIC',
    quoteId: quote.quoteId ?? null,
    requestId: response.requestId ?? null,
    type: p.type,
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: amountOf(amountInRaw, p.tokenIn.decimals),
    amountOut: amountOf(amountOutRaw, p.tokenOut.decimals),
    minAmountOut,
    maxAmountIn,
    slippagePct: slippage,
    priceImpactPct: typeof quote.priceImpact === 'number' ? quote.priceImpact : null,
    gasFee: {
      wei: quote.gasFee && /^\d+$/.test(quote.gasFee) ? quote.gasFee : null,
      usd: quote.gasFeeUSD ?? null,
    },
    gasUseEstimate: quote.gasUseEstimate ?? null,
    route: parseRoute(quote),
    txFailureReasons: (quote.txFailureReasons ?? []).map(String),
    blockNumber: quote.blockNumber ?? null,
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUOTE_FRESHNESS_MS).toISOString(),
  };
}
