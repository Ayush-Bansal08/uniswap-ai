/**
 * get_quote — Uniswap Trading API `/quote`, CLASSIC routing only (swap-integration skill, Step 2).
 * Also the basis of mainnet USD reference prices (services/prices.ts).
 */
import { toRaw } from '../amounts.js';
import { requireReadableChain } from '../context.js';
import { invalidInput } from '../errors.js';
import { GetQuoteInputSchema, GetQuoteOutputSchema } from '../schemas.js';
import { fetchClassicQuote, normalizeQuote, type ClassicQuoteParams } from '../services/quote.js';
import { defineTool } from './define.js';

export const getQuoteTool = defineTool({
  name: 'get_quote',
  title: 'Uniswap quote (Trading API)',
  description:
    'Quote a swap with the Uniswap Trading API (/quote, CLASSIC AMM routing over v2/v3/v4). Tokens by allowlisted symbol (ETH, WETH, USDC, …) or address; amount is a human decimal of tokenIn (EXACT_INPUT) or tokenOut (EXACT_OUTPUT). Returns raw + decimal amounts, min out / max in after slippage, price impact, gas (wei + USD), the route (pools, fee tiers, v4 hooks) and quoteId. Works on the execution chain and on Ethereum mainnet (chainId 1) for reference prices. Read-only.',
  kind: 'read',
  input: GetQuoteInputSchema,
  output: GetQuoteOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    const [tokenIn, tokenOut] = await Promise.all([
      deps.tokens.resolve(args.chainId, args.tokenIn),
      deps.tokens.resolve(args.chainId, args.tokenOut),
    ]);
    if (tokenIn.address === tokenOut.address)
      throw invalidInput('tokenIn and tokenOut must differ');
    const exact = args.type === 'EXACT_INPUT' ? tokenIn : tokenOut;
    const params: ClassicQuoteParams = {
      chainId: args.chainId,
      tokenIn,
      tokenOut,
      amountRaw: toRaw(args.amount, exact.decimals),
      type: args.type,
      swapper: args.swapper as `0x${string}`,
      ...(args.slippagePct !== undefined ? { slippagePct: args.slippagePct } : {}),
    };
    const { response, quote } = await fetchClassicQuote(deps, params, { cache: true });
    return normalizeQuote(deps, params, response, quote);
  },
  summarize(o) {
    const impact = o.priceImpactPct !== null ? `${o.priceImpactPct}% impact` : 'impact n/a';
    const gas = o.gasFee.usd ? `gas ≈ $${Number(o.gasFee.usd).toFixed(4)}` : 'gas n/a';
    return `Quote on chain ${o.chainId}: ${o.amountIn.decimal} ${o.tokenIn.symbol} → ${
      o.amountOut.decimal
    } ${o.tokenOut.symbol} (${impact}, ${gas}) via ${
      o.route.summary ?? `${o.route.pools.length} pool(s)`
    }. Expires ${o.expiresAt}.`;
  },
});
