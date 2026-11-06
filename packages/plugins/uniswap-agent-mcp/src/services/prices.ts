/**
 * USD reference prices from Ethereum mainnet. Testnet pools are 10–15× off real prices
 * (FEEDBACK.md), so USD values always come from a mainnet CLASSIC quote of one whole token
 * into mainnet USDC (cached 30 s). USDC itself is the unit (1.00).
 */
import { amountOf, Decimal } from '../amounts.js';
import { TTL } from '../cache.js';
import { MAINNET_CHAIN_ID, requireChainAddress } from '../chains.js';
import type { ToolDeps } from '../context.js';
import { fetchClassicQuote, REFERENCE_SWAPPER } from './quote.js';

export const REFERENCE_PRICE_SOURCE =
  'Uniswap Trading API /quote on Ethereum mainnet: 1 token → USDC (CLASSIC route), cached 30 s';

/** USD price of a reference symbol (e.g. "ETH"), or null if it has no mainnet token. */
export async function getReferencePriceUsd(deps: ToolDeps, symbol: string): Promise<string | null> {
  const upper = symbol.trim().toUpperCase();
  if (upper === 'USDC') return '1';
  const token = deps.tokens.mainnetToken(upper === 'WETH' ? 'ETH' : upper);
  if (!token) return null;
  return deps.cache.wrap(
    `ref-price:${upper === 'WETH' ? 'ETH' : upper}`,
    TTL.referencePrice,
    async () => {
      const usdcAddress = requireChainAddress(MAINNET_CHAIN_ID, 'usdc');
      const usdc = deps.tokens.findAllowed(MAINNET_CHAIN_ID, usdcAddress)!;
      const { quote } = await fetchClassicQuote(deps, {
        chainId: MAINNET_CHAIN_ID,
        tokenIn: token,
        tokenOut: usdc,
        amountRaw: 10n ** BigInt(token.decimals),
        type: 'EXACT_INPUT',
        swapper: REFERENCE_SWAPPER,
      });
      const out = amountOf(BigInt(quote.output?.amount ?? '0'), usdc.decimals);
      return new Decimal(out.decimal).toDecimalPlaces(6).toFixed();
    }
  );
}

/** Like getReferencePriceUsd but never throws (logs and returns null). */
export async function tryReferencePriceUsd(deps: ToolDeps, symbol: string): Promise<string | null> {
  try {
    return await getReferencePriceUsd(deps, symbol);
  } catch (err) {
    deps.log.warn('reference price unavailable', {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Reference USD price for a token on any chain (via its mainnet reference symbol). */
export async function priceForToken(
  deps: ToolDeps,
  chainId: number,
  address: string
): Promise<string | null> {
  const ref = deps.tokens.referenceSymbolFor(chainId, address);
  return ref ? tryReferencePriceUsd(deps, ref) : null;
}
