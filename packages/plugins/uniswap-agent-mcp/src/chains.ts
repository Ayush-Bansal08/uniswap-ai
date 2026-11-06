/**
 * Per-chain contract and token addresses — the single source of truth for this package.
 *
 * Every address is copied from the vendored Uniswap docs (never guessed):
 *   [D] docs/vendor/uniswap-v4-deployments.md        (PoolManager, PositionManager, StateView,
 *                                                      Quoter, Permit2, Universal Router)
 *   [S] docs/vendor/uniswap-supported-chains.md      (Universal Router 2.1.2 per chain)
 *   [C] docs/vendor/uniswap-ai/packages/plugins/uniswap-cca/skills/configurator/SKILL.md
 *       ("Network-Specific Constants": USDC per chain)
 *   [R] docs/vendor/uniswap-ai/packages/plugins/uniswap-driver/references/chains.md
 *       (mainnet "Common Tokens": USDC, WETH)
 *
 * A value that is not in those docs is `null`, and `requireChainAddress` throws a clear
 * NOT_CONFIGURED error when a tool needs it. Never fill a null with a remembered address.
 */
import { getAddress, type Address } from 'viem';
import { McpToolError } from './errors.js';

export const NATIVE_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
export const ZERO_ADDRESS: Address = NATIVE_ADDRESS;
export const MAINNET_CHAIN_ID = 1;

export interface ChainAddresses {
  chainId: number;
  name: string;
  isTestnet: boolean;
  nativeSymbol: string;
  /** Average seconds per block (CCA skill "Network-Specific Constants"). */
  blockTimeSeconds: number;
  poolManager: Address;
  positionManager: Address;
  stateView: Address;
  v4Quoter: Address;
  permit2: Address;
  /** Universal Router per version; the Trading API builds calldata for the requested version. */
  universalRouter: { '2.1.2': Address | null; '2.2.0': Address | null };
  weth: Address | null;
  usdc: Address | null;
  /** First block to scan for PoolManager `Initialize` logs. Not in the vendor docs → discovered via RPC. */
  poolManagerStartBlock: bigint | null;
}

const a = (value: string): Address => getAddress(value);

export const CHAINS: Readonly<Record<number, Readonly<ChainAddresses>>> = Object.freeze({
  1: Object.freeze({
    chainId: 1,
    name: 'Ethereum',
    isTestnet: false,
    nativeSymbol: 'ETH',
    blockTimeSeconds: 12, // [C]
    poolManager: a('0x000000000004444c5dc75cB358380D2e3dE08A90'), // [D] Ethereum: 1
    positionManager: a('0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'), // [D]
    stateView: a('0x7ffe42c4a5deea5b0fec41c94c136cf115597227'), // [D]
    v4Quoter: a('0x99bd42B2B22e531f283b7F8a86dFf631EB16A9D1'), // [D] Quoter (V4Quoter.sol)
    permit2: a('0x000000000022D473030F116dDEE9F6B43aC78BA3'), // [D]
    universalRouter: {
      '2.1.2': a('0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85'), // [S] / [D]
      '2.2.0': null,
    },
    weth: a('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), // [R]
    usdc: a('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), // [R] and [C]
    poolManagerStartBlock: null,
  }),
  11155111: Object.freeze({
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    isTestnet: true,
    nativeSymbol: 'ETH',
    blockTimeSeconds: 12, // [C]
    poolManager: a('0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'), // [D] Sepolia: 11155111
    positionManager: a('0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4'), // [D]
    stateView: a('0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c'), // [D]
    v4Quoter: a('0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244'), // [D]
    permit2: a('0x000000000022D473030F116dDEE9F6B43aC78BA3'), // [D]
    universalRouter: {
      '2.1.2': a('0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3'), // [S] / [D]
      '2.2.0': null,
    },
    // Sepolia WETH is not listed in any vendored doc. v4 pools use native ETH, so it is only
    // needed for v3 pools; add it through TOKEN_ALLOWLIST_JSON if required.
    weth: null,
    usdc: a('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'), // [C] Sepolia
    poolManagerStartBlock: null,
  }),
  84532: Object.freeze({
    chainId: 84532,
    name: 'Base Sepolia',
    isTestnet: true,
    nativeSymbol: 'ETH',
    blockTimeSeconds: 2,
    poolManager: a('0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408'), // [D] Base Sepolia: 84532
    positionManager: a('0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80'), // [D]
    stateView: a('0x571291b572ed32ce6751a2cb2486ebee8defb9b4'), // [D]
    v4Quoter: a('0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba'), // [D]
    permit2: a('0x000000000022D473030F116dDEE9F6B43aC78BA3'), // [D]
    universalRouter: {
      '2.1.2': a('0x8702463e73f74d0b6765aBceb314Ef07aCb92650'), // [S] / [D]
      '2.2.0': null,
    },
    weth: null,
    usdc: null, // not in vendored docs
    poolManagerStartBlock: null,
  }),
  1301: Object.freeze({
    chainId: 1301,
    name: 'Unichain Sepolia',
    isTestnet: true,
    nativeSymbol: 'ETH',
    blockTimeSeconds: 2, // [C]
    poolManager: a('0x00b036b58a818b1bc34d502d3fe730db729e62ac'), // [D] Unichain Sepolia: 1301
    positionManager: a('0xf969aee60879c54baaed9f3ed26147db216fd664'), // [D]
    stateView: a('0xc199f1072a74d4e905aba1a84d9a45e2546b6222'), // [D]
    v4Quoter: a('0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472'), // [D]
    permit2: a('0x000000000022D473030F116dDEE9F6B43aC78BA3'), // [D]
    universalRouter: {
      '2.1.2': a('0xDf38F24fE153761634Be942F9d859f3DBA857E95'), // [S] / [D]
      '2.2.0': null,
    },
    weth: null,
    // [C] lists the Unichain *mainnet* USDC for 1301, which conflicts with the testnet token we
    // verified on-chain (see FEEDBACK.md). Left null on purpose: configure via TOKEN_ALLOWLIST_JSON.
    usdc: null,
    poolManagerStartBlock: null,
  }),
});

export function isKnownChain(chainId: number): boolean {
  return Object.prototype.hasOwnProperty.call(CHAINS, chainId);
}

export function getChain(chainId: number): Readonly<ChainAddresses> {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new McpToolError(
      'UNSUPPORTED_CHAIN',
      `Chain ${chainId} has no Uniswap v4 deployment entry in chains.ts (known: ${Object.keys(
        CHAINS
      ).join(', ')}).`
    );
  }
  return chain;
}

type NullableKey = 'weth' | 'usdc';

/** Returns a chain address or fails loudly when the vendor docs do not list it. */
export function requireChainAddress(chainId: number, key: NullableKey): Address {
  const value = getChain(chainId)[key];
  if (!value) {
    throw new McpToolError(
      'NOT_CONFIGURED',
      `${key.toUpperCase()} on chain ${chainId} is not listed in the vendored Uniswap docs, so it is not ` +
        `configured. Add it to TOKEN_ALLOWLIST_JSON after verifying it on-chain.`,
      { retryable: false }
    );
  }
  return value;
}

export function universalRouterFor(chainId: number, version: '2.1.2' | '2.2.0'): Address | null {
  return getChain(chainId).universalRouter[version];
}

/** v4 dynamic-fee flag (LPFeeLibrary.DYNAMIC_FEE_FLAG). */
export const DYNAMIC_FEE_FLAG = 0x800000;
