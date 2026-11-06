/**
 * get_portfolio — native + ERC-20 balances (multicall) priced with mainnet reference prices.
 * P&L / cost basis is the caller's job.
 */
import { getAddress } from 'viem';
import { fromRaw, sumDecimals, usdValue } from '../amounts.js';
import { requireReadableChain } from '../context.js';
import { GetPortfolioInputSchema, GetPortfolioOutputSchema, type TokenInfo } from '../schemas.js';
import { REFERENCE_PRICE_SOURCE, tryReferencePriceUsd } from '../services/prices.js';
import { defineTool, short } from './define.js';

export const getPortfolioTool = defineTool({
  name: 'get_portfolio',
  title: 'Wallet portfolio',
  description:
    'Balances of native ETH and allowlisted ERC-20s (or the given tokens) for an address, via multicall, with USD prices from Ethereum-mainnet Uniswap reference quotes (testnet pool prices are not used for USD). Returns per-token balanceRaw/balance/priceUsd/valueUsd and totalUsd. Read-only.',
  kind: 'read',
  input: GetPortfolioInputSchema,
  output: GetPortfolioOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    const owner = getAddress(args.address);
    const tokens: TokenInfo[] = args.tokens
      ? await Promise.all(args.tokens.map((t) => deps.tokens.resolve(args.chainId, t)))
      : deps.tokens.allowlist(args.chainId).map((t) => ({ ...t }));
    const unique = [...new Map(tokens.map((t) => [t.address.toLowerCase(), t])).values()];
    const reader = deps.reader(args.chainId);
    const erc20s = unique.filter((t) => !t.isNative);
    const [nativeBalance, erc20Balances, blockNumber] = await Promise.all([
      unique.some((t) => t.isNative) ? reader.getBalance(owner) : Promise.resolve(0n),
      reader.erc20Balances(
        owner,
        erc20s.map((t) => t.address as `0x${string}`)
      ),
      reader
        .getBlockNumber()
        .then(String)
        .catch(() => null),
    ]);
    const balanceOf = new Map<string, bigint>(
      erc20s.map((t, i) => [t.address.toLowerCase(), erc20Balances[i] ?? 0n])
    );

    const refSymbols = [
      ...new Set(
        unique
          .map((t) => deps.tokens.referenceSymbolFor(args.chainId, t.address))
          .filter((s): s is string => !!s)
      ),
    ];
    const prices = new Map(
      await Promise.all(
        refSymbols.map(async (s) => [s, await tryReferencePriceUsd(deps, s)] as const)
      )
    );

    const rows = unique.map((t) => {
      const raw = t.isNative ? nativeBalance : balanceOf.get(t.address.toLowerCase()) ?? 0n;
      const balance = fromRaw(raw, t.decimals);
      const ref = deps.tokens.referenceSymbolFor(args.chainId, t.address);
      const priceUsd = ref ? prices.get(ref) ?? null : null;
      return {
        symbol: t.symbol,
        address: getAddress(t.address),
        decimals: t.decimals,
        isNative: t.isNative,
        balanceRaw: raw.toString(),
        balance,
        priceUsd,
        valueUsd: priceUsd !== null ? usdValue(balance, priceUsd) : null,
      };
    });
    return {
      chainId: args.chainId,
      address: owner,
      tokens: rows,
      totalUsd: sumDecimals(rows.map((r) => r.valueUsd).filter((v): v is string => v !== null)),
      unpriced: rows
        .filter((r) => r.priceUsd === null && r.balanceRaw !== '0')
        .map((r) => r.symbol),
      priceSource: REFERENCE_PRICE_SOURCE,
      blockNumber,
      asOf: new Date(deps.now()).toISOString(),
    };
  },
  summarize(o) {
    const held = o.tokens
      .filter((t) => t.balanceRaw !== '0')
      .map((t) => `${t.balance} ${t.symbol}`);
    return `Portfolio of ${short(o.address)} on chain ${o.chainId}: $${o.totalUsd} (${
      held.length ? held.join(', ') : 'no balances'
    })${o.unpriced.length ? `; unpriced: ${o.unpriced.join(', ')}` : ''}.`;
  },
});
