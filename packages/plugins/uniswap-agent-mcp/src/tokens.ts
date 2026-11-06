/**
 * Token allowlist, metadata cache and symbol → address resolution.
 *
 * Allowlist per chain = native ETH, WETH and USDC from chains.ts (vendor-doc addresses) plus
 * TOKEN_ALLOWLIST_JSON. Symbols resolve ONLY against the allowlist (an agent can never trade a
 * look-alike "USDC" by symbol); arbitrary tokens must be passed by address and are flagged.
 */
import { getAddress, isAddress, type Address } from 'viem';
import { TTL, type TtlCache } from './cache.js';
import { CHAINS, getChain, MAINNET_CHAIN_ID, NATIVE_ADDRESS } from './chains.js';
import type { ChainReader } from './clients/rpc.js';
import type { FetchLike } from './clients/http.js';
import type { AllowlistEntry } from './config.js';
import { McpToolError } from './errors.js';
import type { TokenInfo } from './schemas.js';

export interface AllowedToken extends TokenInfo {
  chainId: number;
  /** Symbol of the mainnet asset used for USD reference prices. */
  referenceSymbol: string;
}

export class TokenRegistry {
  private readonly byChain = new Map<number, AllowedToken[]>();

  constructor(
    extra: readonly AllowlistEntry[] = [],
    private readonly cache: TtlCache,
    private readonly readerFor: (chainId: number) => ChainReader
  ) {
    for (const chain of Object.values(CHAINS)) {
      const list: AllowedToken[] = [
        {
          chainId: chain.chainId,
          address: NATIVE_ADDRESS,
          symbol: chain.nativeSymbol,
          decimals: 18,
          isNative: true,
          referenceSymbol: 'ETH',
        },
      ];
      if (chain.weth)
        list.push({
          chainId: chain.chainId,
          address: chain.weth,
          symbol: 'WETH',
          decimals: 18,
          isNative: false,
          referenceSymbol: 'ETH',
        });
      if (chain.usdc)
        list.push({
          chainId: chain.chainId,
          address: chain.usdc,
          symbol: 'USDC',
          decimals: 6,
          isNative: false,
          referenceSymbol: 'USDC',
        });
      this.byChain.set(chain.chainId, list);
    }
    for (const entry of extra) {
      const list = this.byChain.get(entry.chainId) ?? [];
      const address = getAddress(entry.address);
      if (
        list.some(
          (t) => t.address === address || t.symbol.toUpperCase() === entry.symbol.toUpperCase()
        )
      ) {
        continue; // built-ins win; never let config shadow ETH/WETH/USDC
      }
      list.push({
        chainId: entry.chainId,
        address,
        symbol: entry.symbol,
        decimals: entry.decimals,
        isNative: false,
        referenceSymbol: (entry.referenceSymbol ?? entry.symbol).toUpperCase(),
      });
      this.byChain.set(entry.chainId, list);
    }
  }

  allowlist(chainId: number): readonly AllowedToken[] {
    return this.byChain.get(chainId) ?? [];
  }

  findAllowed(chainId: number, address: string): AllowedToken | undefined {
    const lower = address.toLowerCase();
    return this.allowlist(chainId).find((t) => t.address.toLowerCase() === lower);
  }

  findBySymbol(chainId: number, symbol: string): AllowedToken | undefined {
    const upper = symbol.toUpperCase();
    return this.allowlist(chainId).find((t) => t.symbol.toUpperCase() === upper);
  }

  isAllowlisted(chainId: number, address: string): boolean {
    return this.findAllowed(chainId, address) !== undefined;
  }

  /** Resolve a symbol (allowlist only) or an address (allowlist, else on-chain metadata). */
  async resolve(chainId: number, input: string): Promise<TokenInfo & { allowlisted: boolean }> {
    getChain(chainId);
    const trimmed = input.trim();
    if (isAddress(trimmed, { strict: false })) {
      const allowed = this.findAllowed(chainId, trimmed);
      if (allowed) return { ...strip(allowed), allowlisted: true };
      const meta = await this.metadata(chainId, getAddress(trimmed));
      if (meta.decimals === null) {
        throw new McpToolError(
          'UNKNOWN_TOKEN',
          `${trimmed} on chain ${chainId} does not look like an ERC-20 (no decimals()).`,
          { retryable: false }
        );
      }
      return {
        address: getAddress(trimmed),
        symbol: meta.symbol ?? 'UNKNOWN',
        decimals: meta.decimals,
        isNative: false,
        allowlisted: false,
      };
    }
    const bySymbol = this.findBySymbol(chainId, trimmed);
    if (!bySymbol) {
      const known = this.allowlist(chainId)
        .map((t) => t.symbol)
        .join(', ');
      throw new McpToolError(
        'UNKNOWN_TOKEN',
        `Unknown token symbol "${trimmed}" on chain ${chainId}. Allowlisted: ${known}. Pass an address for other tokens.`,
        { retryable: false }
      );
    }
    return { ...strip(bySymbol), allowlisted: true };
  }

  /** ERC-20 metadata, cached 24 h. */
  async metadata(
    chainId: number,
    address: Address
  ): Promise<{ symbol: string | null; name: string | null; decimals: number | null }> {
    if (address === NATIVE_ADDRESS) return { symbol: 'ETH', name: 'Ether', decimals: 18 };
    return this.cache.wrap(
      `token-meta:${chainId}:${address.toLowerCase()}`,
      TTL.tokenMetadata,
      async () => {
        const [meta] = await this.readerFor(chainId).erc20Metadata([address]);
        return meta ?? { symbol: null, name: null, decimals: null };
      }
    );
  }

  /** Mainnet reference symbol for a token on any chain (null if it has no mainnet equivalent). */
  referenceSymbolFor(chainId: number, address: string): string | null {
    return this.findAllowed(chainId, address)?.referenceSymbol ?? null;
  }

  /** Mainnet token used to price a reference symbol (ETH → native). */
  mainnetToken(referenceSymbol: string): AllowedToken | undefined {
    const upper = referenceSymbol.toUpperCase();
    return this.allowlist(MAINNET_CHAIN_ID).find(
      (t) => t.symbol.toUpperCase() === upper || (upper === 'ETH' && t.isNative)
    );
  }
}

function strip(token: AllowedToken): TokenInfo {
  return {
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
    isNative: token.isNative,
  };
}

/**
 * Uniswap Labs' unsupported-token list (supported-chains doc, "Supported Tokens for Swapping"),
 * fetched from UNSUPPORTED_TOKENS_URL and cached 24 h. `null` = list unavailable.
 */
export class UnsupportedTokenList {
  constructor(
    private readonly url: string,
    private readonly fetch: FetchLike,
    private readonly cache: TtlCache
  ) {}

  private load(): Promise<Set<string> | null> {
    return this.cache.wrap('unsupported-token-list', TTL.unsupportedList, async () => {
      try {
        const response = await this.fetch(this.url, { headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        const body = (await response.json()) as {
          tokens?: { chainId?: number; address?: string }[];
        };
        if (!Array.isArray(body.tokens)) return null;
        return new Set(
          body.tokens
            .filter((t) => typeof t.chainId === 'number' && typeof t.address === 'string')
            .map((t) => `${t.chainId}:${t.address!.toLowerCase()}`)
        );
      } catch {
        return null;
      }
    });
  }

  async contains(chainId: number, address: string): Promise<boolean | null> {
    const set = await this.load();
    return set ? set.has(`${chainId}:${address.toLowerCase()}`) : null;
  }
}
