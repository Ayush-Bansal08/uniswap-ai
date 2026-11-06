/**
 * Recorded-style fixtures, shaped after the vendored OpenAPI examples (QuoteSuccess200,
 * CreatePositionRequest example) and the LP guide's response interfaces.
 */
import {
  ETH,
  MAINNET_USDC,
  NOW,
  PERMIT2,
  SEPOLIA_PM,
  SEPOLIA_UR,
  SEPOLIA_USDC,
  SWAPPER,
} from './helpers.js';

export const NOW_SEC = Math.floor(NOW / 1000);

export const V4_ETH_USDC_POOL =
  '0x3390c733d8252e864d4ce769398dd3fb8680d1f626719e8d7736d062665f0987';
export const HOOK_POOL = '0x8d1f5cd2f2a3cd8c0b7a7d76e5b8a4c3b2a1908f7e6d5c4b3a29180706f5e4d3';
export const HOOK_ADDR = '0x00000000000000000000000000000000000000c0';

/** /quote ETH → USDC on Sepolia, CLASSIC through a v4 pool, no Permit2 needed. */
export function quoteEthToUsdc(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'b7b6f5a2-0d33-4a1d-9f7c-1d2a3b4c5d6e',
    routing: 'CLASSIC',
    quote: {
      chainId: 11155111,
      input: { amount: '1000000000000000', token: ETH },
      output: { amount: '26350000', token: SEPOLIA_USDC, recipient: SWAPPER },
      swapper: SWAPPER,
      route: [
        [
          {
            type: 'v4-pool',
            address: V4_ETH_USDC_POOL,
            tokenIn: { chainId: 11155111, decimals: '18', address: ETH, symbol: 'ETH' },
            tokenOut: { chainId: 11155111, decimals: '6', address: SEPOLIA_USDC, symbol: 'USDC' },
            fee: '3000',
            tickSpacing: '60',
            hooks: '0x0000000000000000000000000000000000000000',
            liquidity: '82781860385007263',
            sqrtRatioX96: '4054976509207624931672233',
            tickCurrent: '-196300',
            amountIn: '1000000000000000',
            amountOut: '26350000',
          },
        ],
      ],
      slippage: 0.5,
      tradeType: 'EXACT_INPUT',
      quoteId: '62e83902-9455-405d-8c62-cdf8ee9e2042',
      gasFeeUSD: '0.012',
      gasFeeQuote: '489108586810000',
      gasUseEstimate: '180350',
      priceImpact: 0.14,
      txFailureReasons: [],
      maxPriorityFeePerGas: '2000000000',
      maxFeePerGas: '4656513686',
      gasFee: '489108586810000',
      routeString:
        '[V4] 100.00% = ETH -- 0.3% [0x3390c733d8252e864d4ce769398dd3fb8680d1f626719e8d7736d062665f0987]USDC',
      blockNumber: '7000000',
      ...overrides,
    },
    permitData: null,
    permitTransaction: null,
  };
}

export const PERMIT_SINGLE = {
  domain: { name: 'Permit2', chainId: 11155111, verifyingContract: PERMIT2 },
  types: {
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  values: {
    details: {
      token: SEPOLIA_USDC,
      amount: '1461501637330902918203684832716283019655932542975',
      expiration: '1765000000',
      nonce: '0',
    },
    spender: SEPOLIA_UR,
    sigDeadline: '1762432000',
  },
};

/** /quote 20 USDC → ETH with Permit2 data. */
export function quoteUsdcToEthWithPermit() {
  return {
    requestId: 'c1c2c3c4-0000-4000-8000-000000000001',
    routing: 'CLASSIC',
    quote: {
      chainId: 11155111,
      input: { amount: '20000000', token: SEPOLIA_USDC },
      output: { amount: '740000000000000', token: ETH, recipient: SWAPPER },
      swapper: SWAPPER,
      route: [
        [
          {
            type: 'v4-pool',
            address: V4_ETH_USDC_POOL,
            tokenIn: { chainId: 11155111, decimals: '6', address: SEPOLIA_USDC, symbol: 'USDC' },
            tokenOut: { chainId: 11155111, decimals: '18', address: ETH, symbol: 'ETH' },
            fee: '3000',
            tickSpacing: '60',
            hooks: '0x0000000000000000000000000000000000000000',
            liquidity: '82781860385007263',
            sqrtRatioX96: '4054976509207624931672233',
            tickCurrent: '-196300',
          },
        ],
      ],
      slippage: 0.5,
      tradeType: 'EXACT_INPUT',
      quoteId: 'q-usdc-eth',
      gasFeeUSD: '0.02',
      gasUseEstimate: '200000',
      priceImpact: 1.6,
      txFailureReasons: [],
      gasFee: '600000000000000',
      routeString: '[V4] 100.00% = USDC -- 0.3% ETH',
      blockNumber: '7000000',
    },
    permitData: PERMIT_SINGLE,
    permitTransaction: null,
  };
}

/** /quote on mainnet used for reference prices (1 ETH → USDC). */
export function mainnetEthPriceQuote(usdcOut = '3247180000') {
  return {
    requestId: 'ref-1',
    routing: 'CLASSIC',
    quote: {
      chainId: 1,
      input: { amount: '1000000000000000000', token: ETH },
      output: { amount: usdcOut, token: MAINNET_USDC },
      swapper: '0x000000000000000000000000000000000000dEaD',
      route: [],
      slippage: 0.5,
      tradeType: 'EXACT_INPUT',
      priceImpact: 0.01,
      gasFee: '1',
      gasFeeUSD: '1.2',
      routeString: '[V4] ETH -- USDC',
    },
    permitData: null,
  };
}

export const SWAP_CALLDATA =
  '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0';

export function swapResponse(value = '1000000000000000', overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'swap-1',
    swap: {
      to: SEPOLIA_UR,
      from: SWAPPER,
      data: SWAP_CALLDATA,
      value,
      chainId: 11155111,
      gasLimit: '250000',
      maxFeePerGas: '4656513686',
      maxPriorityFeePerGas: '2000000000',
      ...overrides,
    },
    gasFee: '1164128421500000',
  };
}

export const APPROVE_PERMIT2_CALLDATA =
  '0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

export function approvalResponse(needed = true) {
  return {
    requestId: 'appr-1',
    approval: needed
      ? {
          to: SEPOLIA_USDC,
          from: SWAPPER,
          data: APPROVE_PERMIT2_CALLDATA,
          value: '0',
          chainId: 11155111,
        }
      : null,
    cancel: null,
    gasFee: '46000000000000',
  };
}

/** LP API v4 batch permit as the API returns it (proto-encoded: enum chainId, wrapped fields). */
export const V4_BATCH_PERMIT_PROTO = {
  domain: { name: 'Permit2', chainId: 'SEPOLIA', verifyingContract: PERMIT2 },
  types: {
    PermitBatch: {
      fields: [
        { name: 'details', type: 'PermitDetails[]' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    PermitDetails: {
      fields: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
  },
  values: {
    details: [
      {
        token: SEPOLIA_USDC,
        amount: '1461501637330902918203684832716283019655932542975',
        expiration: '1765000000',
        nonce: '0',
      },
    ],
    spender: SEPOLIA_PM,
    sigDeadline: '1762432000',
  },
};

export const LP_CREATE_CALLDATA =
  '0xdd46508f00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000069999999';

export function lpCreateResponse(owner: string = SWAPPER) {
  return {
    requestId: 'lp-create-1',
    token0: { tokenAddress: ETH, amount: '1000000000000000' },
    token1: { tokenAddress: SEPOLIA_USDC, amount: '25120443' },
    tickLower: -196860,
    tickUpper: -195780,
    adjustedMinPrice: '2780.112',
    adjustedMaxPrice: '3089.9876',
    create: {
      to: SEPOLIA_PM,
      from: owner,
      data: LP_CREATE_CALLDATA,
      value: '1000000000000000',
      chainId: 11155111,
    },
  };
}

export function lpDecreaseResponse(owner: string = SWAPPER) {
  return {
    requestId: 'lp-dec-1',
    token0: { tokenAddress: ETH, amount: '500000000000000' },
    token1: { tokenAddress: SEPOLIA_USDC, amount: '12500000' },
    decrease: { to: SEPOLIA_PM, from: owner, data: '0xdd46508f01', value: '0', chainId: 11155111 },
  };
}

export function lpClaimResponse(owner: string = SWAPPER) {
  return {
    requestId: 'lp-claim-1',
    token0: { tokenAddress: ETH, amount: '1000000000000' },
    token1: { tokenAddress: SEPOLIA_USDC, amount: '30000' },
    claim: { to: SEPOLIA_PM, from: owner, data: '0xdd46508f02', value: '0', chainId: 11155111 },
  };
}

export function subgraphResponse(
  data: Record<string, unknown>,
  meta = { number: 23_700_000, timestamp: NOW_SEC - 400 },
  hasIndexingErrors = false
) {
  return { data: { ...data, _meta: { block: meta, hasIndexingErrors } } };
}
