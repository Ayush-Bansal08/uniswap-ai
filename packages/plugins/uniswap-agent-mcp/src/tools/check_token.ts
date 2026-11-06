/**
 * check_token — is this token safe to trade? Allowlist, Uniswap unsupported-token list
 * (supported-chains doc), contract check, and a $1k liquidity probe via /quote price impact.
 */
import { getAddress } from 'viem';
import { Decimal } from '../amounts.js';
import { getChain, MAINNET_CHAIN_ID, NATIVE_ADDRESS } from '../chains.js';
import { requireReadableChain, type ToolDeps } from '../context.js';
import { McpToolError } from '../errors.js';
import { CheckTokenInputSchema, CheckTokenOutputSchema, type TokenInfo } from '../schemas.js';
import { fetchClassicQuote, REFERENCE_SWAPPER } from '../services/quote.js';
import { defineTool } from './define.js';

export const PROBE_USD = 1_000;
/** Liquidity depth below this is CAUTION (matches the product's minLiquidityDepthUsd). */
export const MIN_LIQUIDITY_DEPTH_USD = 10_000;
const DEPTH_CAP = new Decimal(1_000_000_000);

/**
 * Depth estimate: for a constant-product pool, price impact ≈ trade / reserve, so the USD
 * reserve on the probed side ≈ probe / impact.
 */
export function depthFromImpact(probeUsd: number, impactPct: number | null): string | null {
  if (impactPct === null) return null;
  if (impactPct <= 0) return DEPTH_CAP.toFixed(0);
  const depth = new Decimal(probeUsd).div(new Decimal(impactPct).div(100));
  return Decimal.min(depth, DEPTH_CAP).toDecimalPlaces(0).toFixed();
}

async function probe(deps: ToolDeps, chainId: number, token: TokenInfo) {
  // Prefer the mainnet equivalent (real liquidity); fall back to the execution chain.
  const ref = deps.tokens.referenceSymbolFor(chainId, token.address);
  const onMainnet = ref ? deps.tokens.mainnetToken(ref) : undefined;
  const probeChain = onMainnet ? MAINNET_CHAIN_ID : chainId;
  const target = onMainnet ?? token;
  const usdc = deps.tokens.findBySymbol(probeChain, 'USDC');
  if (!usdc) return null;
  // USDC is probed against ETH; everything else is bought with $1k of USDC.
  const isUsdc = target.address.toLowerCase() === usdc.address.toLowerCase();
  const eth = deps.tokens.allowlist(probeChain).find((t) => t.isNative)!;
  const { quote } = await fetchClassicQuote(
    deps,
    {
      chainId: probeChain,
      tokenIn: usdc,
      tokenOut: isUsdc ? eth : target,
      amountRaw: BigInt(PROBE_USD) * 10n ** BigInt(usdc.decimals),
      type: 'EXACT_INPUT',
      swapper: REFERENCE_SWAPPER,
    },
    { cache: true }
  );
  return {
    chainId: probeChain,
    sizeUsd: String(PROBE_USD),
    priceImpactPct: typeof quote.priceImpact === 'number' ? quote.priceImpact : null,
    method:
      probeChain === MAINNET_CHAIN_ID
        ? `Trading API /quote: $${PROBE_USD} USDC → ${
            isUsdc ? 'ETH' : target.symbol
          } on Ethereum mainnet (reference equivalent)`
        : `Trading API /quote: $${PROBE_USD} USDC → ${target.symbol} on the execution testnet (testnet liquidity, indicative only)`,
  };
}

export const checkTokenTool = defineTool({
  name: 'check_token',
  title: 'Token safety check',
  description:
    'Check whether a token is safe to trade: allowlist membership, the Uniswap Labs unsupported-token list, whether it is a contract, decimals/symbol sanity, and liquidity depth estimated from the price impact of a $1,000 quote (mainnet equivalent when known, else the execution chain). Returns riskFlags and a verdict OK | CAUTION | BLOCK. Read-only.',
  kind: 'read',
  input: CheckTokenInputSchema,
  output: CheckTokenOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    getChain(args.chainId);
    const token = await deps.tokens.resolve(args.chainId, args.token).catch(async (err) => {
      // Not an ERC-20 / unknown symbol: still report what we can for addresses.
      if (
        err instanceof McpToolError &&
        err.code === 'UNKNOWN_TOKEN' &&
        /^0x[0-9a-fA-F]{40}$/.test(args.token)
      ) {
        return {
          address: getAddress(args.token),
          symbol: 'UNKNOWN',
          decimals: -1,
          isNative: false,
          allowlisted: false,
        };
      }
      throw err;
    });
    const isNative = token.address.toLowerCase() === NATIVE_ADDRESS;
    const reader = deps.reader(args.chainId);
    const [code, meta, unsupported] = await Promise.all([
      isNative ? Promise.resolve(undefined) : reader.getCode(token.address as `0x${string}`),
      isNative
        ? Promise.resolve({ symbol: 'ETH', name: 'Ether', decimals: 18 })
        : deps.tokens.metadata(args.chainId, token.address as `0x${string}`),
      deps.unsupported.contains(args.chainId, token.address),
    ]);
    const isContract = !!code && code !== '0x';
    const onAllowlist = deps.tokens.isAllowlisted(args.chainId, token.address);

    let liquidityProbe: Awaited<ReturnType<typeof probe>> = null;
    let probeError: string | null = null;
    if (token.decimals >= 0 && (isNative || isContract)) {
      try {
        liquidityProbe = await probe(deps, args.chainId, token);
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }
    }
    const hasQuote = liquidityProbe !== null;
    const depth = liquidityProbe ? depthFromImpact(PROBE_USD, liquidityProbe.priceImpactPct) : null;

    const flags: string[] = [];
    if (!onAllowlist) flags.push('NOT_ON_ALLOWLIST');
    if (unsupported === true) flags.push('ON_UNISWAP_UNSUPPORTED_LIST');
    if (unsupported === null) flags.push('UNSUPPORTED_LIST_UNAVAILABLE');
    if (!isNative && !isContract) flags.push('NOT_A_CONTRACT');
    if (meta.decimals === null) flags.push('NO_DECIMALS');
    else if (![6, 8, 18].includes(meta.decimals)) flags.push('UNUSUAL_DECIMALS');
    if (!meta.symbol) flags.push('NO_SYMBOL');
    if (!hasQuote) flags.push(probeError ? 'NO_QUOTE' : 'NO_LIQUIDITY_PROBE');
    if (depth !== null && new Decimal(depth).lt(MIN_LIQUIDITY_DEPTH_USD))
      flags.push('LOW_LIQUIDITY');
    if (liquidityProbe && liquidityProbe.chainId !== MAINNET_CHAIN_ID)
      flags.push('TESTNET_ONLY_LIQUIDITY_PROBE');

    const block = flags.some((f) =>
      ['ON_UNISWAP_UNSUPPORTED_LIST', 'NOT_A_CONTRACT', 'NO_DECIMALS', 'NO_QUOTE'].includes(f)
    );
    const verdict: 'OK' | 'CAUTION' | 'BLOCK' = block
      ? 'BLOCK'
      : flags.length > 0
      ? 'CAUTION'
      : 'OK';
    return {
      chainId: args.chainId,
      address: getAddress(token.address),
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      isNative,
      onAllowlist,
      onUniswapUnsupportedList: unsupported,
      hasQuote,
      liquidityDepthUsd: depth,
      liquidityProbe,
      isContract,
      riskFlags: flags,
      verdict,
    };
  },
  summarize(o) {
    return `${o.symbol ?? o.address} on chain ${o.chainId}: ${o.verdict}${
      o.riskFlags.length ? ` (${o.riskFlags.join(', ')})` : ''
    }${
      o.liquidityDepthUsd ? `; depth ≈ $${Number(o.liquidityDepthUsd).toLocaleString('en-US')}` : ''
    }.`;
  },
});
