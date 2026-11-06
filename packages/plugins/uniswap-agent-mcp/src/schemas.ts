/**
 * Zod input/output schemas for all 16 tools of the Uniswap agent MCP server, plus the shared
 * build types (TxStep, SignatureRequest, BuildResult).
 *
 * This file depends on `zod` only. It is mirrored byte-for-byte into `packages/shared` so the
 * calling backend validates tool outputs with the exact same schemas (a test enforces this).
 * Every amount is a string: raw uint256 amounts are base-unit integers, human amounts are
 * decimal strings. Never a JS number for token amounts or USD.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const READ_TOOL_NAMES = [
  'get_quote',
  'quote_pool',
  'get_portfolio',
  'get_price_history',
  'get_lp_positions',
  'compare_pools',
  'check_token',
  'list_new_hooks',
  'score_hook',
  'get_hook_state',
] as const;
export const BUILD_TOOL_NAMES = [
  'build_swap',
  'build_transfer',
  'build_lp_position',
  'build_lp_exit',
  'build_rebalance',
] as const;
export const PLAN_TOOL_NAMES = ['plan_trigger'] as const;
export const TOOL_NAMES = [...READ_TOOL_NAMES, ...BUILD_TOOL_NAMES, ...PLAN_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 0x-prefixed 20-byte address');
export const Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 0x-prefixed 32-byte hex value');
export const HexSchema = z.string().regex(/^0x([a-fA-F0-9]{2})*$/, 'Must be 0x-prefixed hex');
/** Raw uint amount in base units, e.g. "1000000" for 1 USDC. */
export const RawAmountSchema = z.string().regex(/^\d+$/, 'Must be a base-unit integer string');
/** Non-negative human decimal, e.g. "0.015". */
export const DecimalStringSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'Must be a non-negative decimal number string');
/** Signed decimal (USD changes, percentages). */
export const SignedDecimalStringSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/, 'Must be a decimal number string');
export const ChainIdSchema = z.number().int().positive();
/** A token by symbol (resolved against the allowlist) or by address. */
export const TokenInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^(0x[a-fA-F0-9]{40}|[A-Za-z0-9.$_-]{1,20})$/, 'Must be a token symbol or 0x address');
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const SlippagePctSchema = z.number().gt(0).max(50);
/** ECDSA signature: 65 bytes (r,s,v) or 64 bytes (EIP-2098 compact). */
export const SignatureHexSchema = z
  .string()
  .regex(/^0x([a-fA-F0-9]{128}|[a-fA-F0-9]{130})$/, 'Must be a 64- or 65-byte hex signature');
export const ResumeTokenSchema = z
  .string()
  .min(16)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Malformed resumeToken');

export const TokenInfoSchema = z.object({
  address: AddressSchema,
  symbol: z.string(),
  decimals: z.number().int().min(0).max(255),
  isNative: z.boolean(),
});
export type TokenInfo = z.infer<typeof TokenInfoSchema>;

export const AmountSchema = z.object({ raw: RawAmountSchema, decimal: DecimalStringSchema });
export type Amount = z.infer<typeof AmountSchema>;

export const TRADE_TYPES = ['EXACT_INPUT', 'EXACT_OUTPUT'] as const;
export const TradeTypeSchema = z.enum(TRADE_TYPES);

export const HOOK_BANDS = ['SAFE', 'CAUTION', 'DANGER'] as const;
export const HookBandSchema = z.enum(HOOK_BANDS);
export type HookBand = z.infer<typeof HookBandSchema>;

export const PoolKeySchema = z.object({
  currency0: AddressSchema,
  currency1: AddressSchema,
  fee: z.number().int().min(0).max(16_777_215),
  tickSpacing: z.number().int().min(1).max(32_767),
  hooks: AddressSchema,
});
export type PoolKey = z.infer<typeof PoolKeySchema>;

// ---------------------------------------------------------------------------
// Errors (returned as MCP tool errors: isError + JSON text `{ error: {...} }`)
// ---------------------------------------------------------------------------

export const TOOL_ERROR_CODES = [
  'INVALID_INPUT',
  'UNSUPPORTED_CHAIN',
  'UNKNOWN_TOKEN',
  'NOT_CONFIGURED',
  'NO_ROUTE',
  'UNSUPPORTED_ROUTING',
  'POOL_NOT_FOUND',
  'POSITION_NOT_FOUND',
  'KYC_REQUIRED',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  'SUBGRAPH_UNAVAILABLE',
  'RPC_ERROR',
  'INVALID_TX',
  'RESUME_TOKEN_INVALID',
  'RESUME_TOKEN_EXPIRED',
  'INTERNAL',
] as const;
export const ToolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});
export type ToolErrorBody = z.infer<typeof ToolErrorSchema>;
export const ToolErrorEnvelopeSchema = z.object({ error: ToolErrorSchema });

// ---------------------------------------------------------------------------
// Shared build types
// ---------------------------------------------------------------------------

export const TX_STEP_KINDS = [
  'APPROVAL',
  'SWAP',
  'TRANSFER',
  'LP_CREATE',
  'LP_DECREASE',
  'LP_CLAIM',
] as const;
export const TxStepKindSchema = z.enum(TX_STEP_KINDS);

export const TxRequestSchema = z.object({
  to: AddressSchema,
  from: AddressSchema,
  data: HexSchema,
  /** wei, decimal string */
  value: RawAmountSchema,
  chainId: ChainIdSchema,
  gasLimit: RawAmountSchema.optional(),
});
export type TxRequest = z.infer<typeof TxRequestSchema>;

export const TxStepSchema = z.object({
  kind: TxStepKindSchema,
  description: z.string().min(1),
  tx: TxRequestSchema,
});
export type TxStep = z.infer<typeof TxStepSchema>;

export const TypedDataFieldSchema = z.object({ name: z.string(), type: z.string() });
export const SignatureRequestSchema = z.object({
  kind: z.enum(['PERMIT2', 'V4_BATCH_PERMIT']),
  /** EIP-712 typed data, already normalised for viem `signTypedData` (numeric chainId, bare type arrays). */
  typedData: z.object({
    domain: z.record(z.unknown()),
    types: z.record(z.array(TypedDataFieldSchema)),
    primaryType: z.string().min(1),
    message: z.record(z.unknown()),
  }),
});
export type SignatureRequest = z.infer<typeof SignatureRequestSchema>;

export const LpSummarySchema = z.object({
  token0: TokenInfoSchema,
  token1: TokenInfoSchema,
  amount0: AmountSchema.optional(),
  amount1: AmountSchema.optional(),
  tickLower: z.number().int().optional(),
  tickUpper: z.number().int().optional(),
  /** token1 per token0, after the API snapped the range to valid ticks. */
  adjustedMinPrice: z.string().optional(),
  adjustedMaxPrice: z.string().optional(),
  /** token1 per token0 implied by our tick bounds (shown before the API responds). */
  expectedMinPrice: z.string().optional(),
  expectedMaxPrice: z.string().optional(),
  tokenId: z.string().optional(),
  percent: z.number().optional(),
});

export const BuildSummarySchema = z.object({
  tokenIn: TokenInfoSchema.optional(),
  tokenOut: TokenInfoSchema.optional(),
  amountIn: AmountSchema.optional(),
  amountOut: AmountSchema.optional(),
  minAmountOut: AmountSchema.optional(),
  maxAmountIn: AmountSchema.optional(),
  priceImpactPct: z.number().optional(),
  gasEstimateWei: RawAmountSchema.optional(),
  gasFeeUsd: z.string().optional(),
  route: z.string().optional(),
  poolRef: z.string().optional(),
  hookAddress: AddressSchema.optional(),
  recipient: AddressSchema.optional(),
  lp: LpSummarySchema.optional(),
});
export type BuildSummary = z.infer<typeof BuildSummarySchema>;

export const BUILD_STATUSES = ['READY', 'NEEDS_SIGNATURE'] as const;

/**
 * Flat object so it can be an MCP outputSchema (which must be an object schema).
 * Status consistency is enforced by `checkBuildResult`:
 *   READY           → steps (non-empty)
 *   NEEDS_SIGNATURE → preSteps (may be empty) + signature + resumeToken
 */
export const BuildResultSchema = z.object({
  status: z.enum(BUILD_STATUSES),
  steps: z.array(TxStepSchema).optional(),
  preSteps: z.array(TxStepSchema).optional(),
  signature: SignatureRequestSchema.optional(),
  resumeToken: z.string().optional(),
  /** When the resumeToken (or the quote behind READY steps) stops being valid. */
  expiresAt: IsoDateTimeSchema.optional(),
  summary: BuildSummarySchema,
  warnings: z.array(z.string()).optional(),
});
export type BuildResultObject = z.infer<typeof BuildResultSchema>;

export type BuildResult =
  | (BuildResultObject & { status: 'READY'; steps: TxStep[] })
  | (BuildResultObject & {
      status: 'NEEDS_SIGNATURE';
      preSteps: TxStep[];
      signature: SignatureRequest;
      resumeToken: string;
    });

/** Returns a list of problems (empty = consistent). */
export function checkBuildResult(result: BuildResultObject): string[] {
  const problems: string[] = [];
  if (result.status === 'READY') {
    if (!result.steps || result.steps.length === 0) problems.push('READY requires steps');
    if (result.signature || result.resumeToken)
      problems.push('READY must not carry signature/resumeToken');
  } else {
    if (!result.preSteps) problems.push('NEEDS_SIGNATURE requires preSteps');
    if (!result.signature) problems.push('NEEDS_SIGNATURE requires signature');
    if (!result.resumeToken) problems.push('NEEDS_SIGNATURE requires resumeToken');
    if (result.steps) problems.push('NEEDS_SIGNATURE must not carry steps');
  }
  return problems;
}

/** Optional finalisation fields accepted by build tools that may need a signature. */
const resumeFields = {
  resumeToken: ResumeTokenSchema.optional(),
  signature: SignatureHexSchema.optional(),
};

// ---------------------------------------------------------------------------
// 1. get_quote
// ---------------------------------------------------------------------------

export const GetQuoteInputSchema = z.object({
  chainId: ChainIdSchema,
  tokenIn: TokenInputSchema,
  tokenOut: TokenInputSchema,
  /** Human decimal amount of tokenIn (EXACT_INPUT) or tokenOut (EXACT_OUTPUT). */
  amount: DecimalStringSchema,
  type: TradeTypeSchema,
  swapper: AddressSchema,
  slippagePct: SlippagePctSchema.optional(),
});

export const RoutePoolSchema = z.object({
  protocol: z.enum(['V2', 'V3', 'V4']),
  /** v2/v3 pool address, or v4 poolId. */
  poolRef: z.string(),
  tokenIn: AddressSchema,
  tokenOut: AddressSchema,
  fee: z.number().int().nullable(),
  tickSpacing: z.number().int().nullable(),
  hooks: AddressSchema.nullable(),
});

export const GetQuoteOutputSchema = z.object({
  chainId: ChainIdSchema,
  routing: z.literal('CLASSIC'),
  quoteId: z.string().nullable(),
  requestId: z.string().nullable(),
  type: TradeTypeSchema,
  tokenIn: TokenInfoSchema,
  tokenOut: TokenInfoSchema,
  amountIn: AmountSchema,
  amountOut: AmountSchema,
  /** EXACT_INPUT: minimum received after slippage. */
  minAmountOut: AmountSchema.nullable(),
  /** EXACT_OUTPUT: maximum spent after slippage. */
  maxAmountIn: AmountSchema.nullable(),
  slippagePct: z.number().nullable(),
  priceImpactPct: z.number().nullable(),
  gasFee: z.object({ wei: RawAmountSchema.nullable(), usd: z.string().nullable() }),
  gasUseEstimate: z.string().nullable(),
  route: z.object({
    summary: z.string().nullable(),
    pools: z.array(RoutePoolSchema),
    hooks: z.array(AddressSchema),
  }),
  txFailureReasons: z.array(z.string()),
  blockNumber: z.string().nullable(),
  quotedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
export type GetQuoteOutput = z.infer<typeof GetQuoteOutputSchema>;

// ---------------------------------------------------------------------------
// 2. quote_pool
// ---------------------------------------------------------------------------

export const QuotePoolInputSchema = z.object({
  chainId: ChainIdSchema,
  poolKey: PoolKeySchema,
  zeroForOne: z.boolean(),
  /** Human decimal amount of the exact side (input for EXACT_INPUT, output for EXACT_OUTPUT). */
  exactAmount: DecimalStringSchema,
  type: TradeTypeSchema,
  hookData: HexSchema.optional(),
});

export const QuotePoolOutputSchema = z.object({
  chainId: ChainIdSchema,
  poolId: Bytes32Schema,
  poolKey: PoolKeySchema,
  type: TradeTypeSchema,
  zeroForOne: z.boolean(),
  tokenIn: TokenInfoSchema,
  tokenOut: TokenInfoSchema,
  amountIn: AmountSchema,
  amountOut: AmountSchema,
  gasEstimate: RawAmountSchema,
  quoter: AddressSchema,
  blockNumber: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// 3. get_portfolio
// ---------------------------------------------------------------------------

export const GetPortfolioInputSchema = z.object({
  chainId: ChainIdSchema,
  address: AddressSchema,
  tokens: z.array(TokenInputSchema).max(50).optional(),
});

export const PortfolioTokenSchema = z.object({
  symbol: z.string(),
  address: AddressSchema,
  decimals: z.number().int(),
  isNative: z.boolean(),
  balanceRaw: RawAmountSchema,
  balance: DecimalStringSchema,
  priceUsd: z.string().nullable(),
  valueUsd: z.string().nullable(),
});

export const GetPortfolioOutputSchema = z.object({
  chainId: ChainIdSchema,
  address: AddressSchema,
  tokens: z.array(PortfolioTokenSchema),
  totalUsd: z.string(),
  /** Symbols whose USD price could not be resolved (excluded from totalUsd). */
  unpriced: z.array(z.string()),
  priceSource: z.string(),
  blockNumber: z.string().nullable(),
  asOf: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// 4. get_price_history
// ---------------------------------------------------------------------------

export const GetPriceHistoryInputSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9.$_-]+$/),
  window: z.enum(['1h', '24h', '7d']),
  interval: z.enum(['hour', 'day']),
});

export const GetPriceHistoryOutputSchema = z.object({
  symbol: z.string(),
  window: z.enum(['1h', '24h', '7d']),
  interval: z.enum(['hour', 'day']),
  source: z.object({
    kind: z.enum(['pool', 'token']),
    id: z.string(),
    description: z.string(),
  }),
  series: z.array(z.object({ ts: IsoDateTimeSchema, priceUsd: z.string() })),
  open: z.string().nullable(),
  close: z.string().nullable(),
  high: z.string().nullable(),
  low: z.string().nullable(),
  changePct: z.string().nullable(),
  /** Timestamp of the last block the subgraph has indexed. */
  asOf: IsoDateTimeSchema.nullable(),
  lagSeconds: z.number().int().nullable(),
  stale: z.boolean(),
  hasIndexingErrors: z.boolean().nullable(),
});

// ---------------------------------------------------------------------------
// 5. get_lp_positions
// ---------------------------------------------------------------------------

export const GetLpPositionsInputSchema = z.object({
  chainId: ChainIdSchema,
  owner: AddressSchema,
  tokenIds: z
    .array(z.string().regex(/^\d+$/, 'tokenId must be a decimal integer string'))
    .min(1)
    .max(50),
});

export const LpPositionSchema = z.object({
  tokenId: z.string(),
  owner: AddressSchema.nullable(),
  ownerMatches: z.boolean(),
  poolId: Bytes32Schema,
  poolKey: PoolKeySchema,
  hookAddress: AddressSchema.nullable(),
  token0: TokenInfoSchema,
  token1: TokenInfoSchema,
  tickLower: z.number().int(),
  tickUpper: z.number().int(),
  currentTick: z.number().int(),
  inRange: z.boolean(),
  liquidity: RawAmountSchema,
  poolLiquidity: RawAmountSchema,
  amount0: AmountSchema,
  amount1: AmountSchema,
  uncollectedFees0: AmountSchema.nullable(),
  uncollectedFees1: AmountSchema.nullable(),
  /** Price token1 per token0 at the range bounds and now. */
  priceLower: z.string(),
  priceUpper: z.string(),
  priceCurrent: z.string(),
  valueUsd: z.string().nullable(),
});

export const GetLpPositionsOutputSchema = z.object({
  chainId: ChainIdSchema,
  owner: AddressSchema,
  positions: z.array(LpPositionSchema),
  notFound: z.array(z.string()),
  totalValueUsd: z.string().nullable(),
  blockNumber: z.string().nullable(),
  asOf: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// 6. compare_pools
// ---------------------------------------------------------------------------

export const ComparePoolsInputSchema = z.object({
  chainId: ChainIdSchema,
  tokenA: TokenInputSchema,
  tokenB: TokenInputSchema,
});

export const ExecutionPoolSchema = z.object({
  poolId: Bytes32Schema,
  fee: z.number().int(),
  tickSpacing: z.number().int(),
  hookAddress: AddressSchema,
  isDynamicFee: z.boolean(),
  liquidity: RawAmountSchema.nullable(),
  currentTick: z.number().int().nullable(),
  sqrtPriceX96: RawAmountSchema.nullable(),
  initialized: z.boolean(),
});

export const MarketPoolSchema = z.object({
  poolId: Bytes32Schema,
  fee: z.number().int(),
  tickSpacing: z.number().int(),
  hookAddress: AddressSchema,
  isDynamicFee: z.boolean(),
  tvlUsd: z.string(),
  volume7dUsd: z.string(),
  fees7dUsd: z.string(),
  feeAprPct: z.string(),
  createdAt: IsoDateTimeSchema,
});

export const RankedPoolSchema = z.object({
  rank: z.number().int().positive(),
  poolId: Bytes32Schema,
  source: z.enum(['execution', 'market']),
  usableOnExecutionChain: z.boolean(),
  fee: z.number().int(),
  tickSpacing: z.number().int(),
  hookAddress: AddressSchema,
  hookBand: HookBandSchema.nullable(),
  hookScore: z.number().nullable(),
  /** Market fee APR of the matching reference pool (same fee/tickSpacing, hookless). */
  referenceFeeAprPct: z.string().nullable(),
  /** APR × hook band factor (SAFE 1, CAUTION 0.5, DANGER 0, unscored 0.5). */
  adjustedAprPct: z.string().nullable(),
  referenceTvlUsd: z.string().nullable(),
  reasons: z.array(z.string()),
});

export const ComparePoolsOutputSchema = z.object({
  chainId: ChainIdSchema,
  tokenA: TokenInfoSchema,
  tokenB: TokenInfoSchema,
  execution: z.object({
    chainId: ChainIdSchema,
    label: z.string(),
    source: z.string(),
    pools: z.array(ExecutionPoolSchema),
    error: z.string().nullable(),
  }),
  market: z.object({
    chainId: z.literal(1),
    label: z.string(),
    source: z.string(),
    pools: z.array(MarketPoolSchema),
    asOf: IsoDateTimeSchema.nullable(),
    error: z.string().nullable(),
  }),
  ranked: z.array(RankedPoolSchema),
  recommended: RankedPoolSchema.nullable(),
  reasons: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// 7. check_token
// ---------------------------------------------------------------------------

export const CheckTokenInputSchema = z.object({
  chainId: ChainIdSchema,
  token: TokenInputSchema,
});

export const CheckTokenOutputSchema = z.object({
  chainId: ChainIdSchema,
  address: AddressSchema,
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().int().nullable(),
  isNative: z.boolean(),
  onAllowlist: z.boolean(),
  /** null = the unsupported-token list could not be fetched. */
  onUniswapUnsupportedList: z.boolean().nullable(),
  hasQuote: z.boolean(),
  liquidityDepthUsd: z.string().nullable(),
  liquidityProbe: z
    .object({
      chainId: ChainIdSchema,
      sizeUsd: z.string(),
      priceImpactPct: z.number().nullable(),
      method: z.string(),
    })
    .nullable(),
  isContract: z.boolean(),
  riskFlags: z.array(z.string()),
  verdict: z.enum(['OK', 'CAUTION', 'BLOCK']),
});

// ---------------------------------------------------------------------------
// 8. list_new_hooks
// ---------------------------------------------------------------------------

export const ListNewHooksInputSchema = z.object({
  scope: z.enum(['market', 'execution']),
  sinceDays: z.number().int().min(1).max(365).optional(),
  pair: z.tuple([TokenInputSchema, TokenInputSchema]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const HookPoolSchema = z.object({
  poolId: Bytes32Schema,
  token0: AddressSchema,
  token1: AddressSchema,
  token0Symbol: z.string().nullable(),
  token1Symbol: z.string().nullable(),
  fee: z.number().int(),
  tickSpacing: z.number().int(),
  isDynamicFee: z.boolean(),
  tvlUsd: z.string().nullable(),
  createdAt: IsoDateTimeSchema.nullable(),
  createdAtBlock: z.string().nullable(),
});

export const ListNewHooksOutputSchema = z.object({
  scope: z.enum(['market', 'execution']),
  chainId: ChainIdSchema,
  sinceDays: z.number().int(),
  hooks: z.array(
    z.object({
      hookAddress: AddressSchema,
      chainId: ChainIdSchema,
      pools: z.array(HookPoolSchema),
      firstSeen: IsoDateTimeSchema.nullable(),
      totalTvlUsd: z.string().nullable(),
    })
  ),
  scannedFromBlock: z.string().nullable(),
  scannedToBlock: z.string().nullable(),
  asOf: IsoDateTimeSchema.nullable(),
  truncated: z.boolean(),
});

// ---------------------------------------------------------------------------
// 9. score_hook
// ---------------------------------------------------------------------------

/** Names and order per v4-core `Hooks.sol` (bit 13 … bit 0). */
export const HOOK_PERMISSION_FLAGS = [
  'beforeInitialize',
  'afterInitialize',
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
  'beforeSwap',
  'afterSwap',
  'beforeDonate',
  'afterDonate',
  'beforeSwapReturnDelta',
  'afterSwapReturnDelta',
  'afterAddLiquidityReturnDelta',
  'afterRemoveLiquidityReturnDelta',
] as const;
export type HookPermissionFlag = (typeof HOOK_PERMISSION_FLAGS)[number];

export const HookPermissionsSchema = z.object({
  beforeInitialize: z.boolean(),
  afterInitialize: z.boolean(),
  beforeAddLiquidity: z.boolean(),
  afterAddLiquidity: z.boolean(),
  beforeRemoveLiquidity: z.boolean(),
  afterRemoveLiquidity: z.boolean(),
  beforeSwap: z.boolean(),
  afterSwap: z.boolean(),
  beforeDonate: z.boolean(),
  afterDonate: z.boolean(),
  beforeSwapReturnDelta: z.boolean(),
  afterSwapReturnDelta: z.boolean(),
  afterAddLiquidityReturnDelta: z.boolean(),
  afterRemoveLiquidityReturnDelta: z.boolean(),
});
export type HookPermissions = z.infer<typeof HookPermissionsSchema>;

export const PERMISSION_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const PermissionRiskLevelSchema = z.enum(PERMISSION_RISK_LEVELS);

export const ScoreHookInputSchema = z.object({
  chainId: ChainIdSchema,
  hookAddress: AddressSchema,
});

export const HookFactsSchema = z.object({
  hasCode: z.boolean(),
  codeSizeBytes: z.number().int(),
  codeHash: Bytes32Schema.nullable(),
  proxy: z.object({
    kind: z.enum(['EIP1967', 'EIP1822', 'BEACON', 'EIP1167']).nullable(),
    implementation: AddressSchema.nullable(),
    admin: AddressSchema.nullable(),
    beacon: AddressSchema.nullable(),
    upgradeable: z.boolean(),
  }),
  owner: AddressSchema.nullable(),
  /** 4-byte selectors of known privileged setters found in the bytecode. */
  adminSelectors: z.array(z.string()),
  /** null = unknown (no ETHERSCAN_API_KEY or lookup failed). */
  verifiedSource: z.boolean().nullable(),
  contractName: z.string().nullable(),
  firstSeenBlock: z.string().nullable(),
  firstSeenAt: IsoDateTimeSchema.nullable(),
  ageDays: z.number().nullable(),
  ageSource: z.string().nullable(),
  poolCount: z.number().int().nullable(),
  dynamicFeePoolCount: z.number().int().nullable(),
  tvlUsd: z.string().nullable(),
});
export type HookFacts = z.infer<typeof HookFactsSchema>;

export const ScoreBreakdownItemSchema = z.object({
  rule: z.string(),
  penalty: z.number(),
  evidence: z.string(),
  /** Section of the Security Framework / v4-security-foundations skill the rule implements. */
  source: z.string(),
});

export const ScoreHookOutputSchema = z.object({
  chainId: ChainIdSchema,
  hookAddress: AddressSchema,
  score: z.number().int().min(0).max(100),
  band: HookBandSchema,
  permissions: HookPermissionsSchema,
  enabledPermissions: z.array(
    z.object({ flag: z.string(), bit: z.number().int(), risk: PermissionRiskLevelSchema })
  ),
  facts: HookFactsSchema,
  breakdown: z.array(ScoreBreakdownItemSchema),
  framework: z.object({
    featureTriggers: z.array(
      z.object({
        feature: z.string(),
        triggered: z.boolean(),
        evidence: z.string(),
        minimumActions: z.array(z.string()),
      })
    ),
    riskScore: z.object({
      permissions: z.number(),
      upgradeMechanism: z.number(),
      observableTotal: z.number(),
      maxTotal: z.literal(33),
      tierAtLeast: z.enum(['Low', 'Medium', 'High', 'Critical']),
      unobserved: z.array(z.string()),
    }),
  }),
  scoredAt: IsoDateTimeSchema,
});
export type ScoreHookOutput = z.infer<typeof ScoreHookOutputSchema>;

// ---------------------------------------------------------------------------
// 10. get_hook_state
// ---------------------------------------------------------------------------

export const GetHookStateInputSchema = z.object({
  chainId: ChainIdSchema,
  hookAddress: AddressSchema,
  poolIds: z.array(Bytes32Schema).max(50).optional(),
});

export const GetHookStateOutputSchema = z.object({
  chainId: ChainIdSchema,
  hookAddress: AddressSchema,
  hasCode: z.boolean(),
  codeHash: Bytes32Schema.nullable(),
  implementation: AddressSchema.nullable(),
  implementationCodeHash: Bytes32Schema.nullable(),
  owner: AddressSchema.nullable(),
  permissionsBitmap: z.number().int(),
  pools: z.array(
    z.object({
      poolId: Bytes32Schema,
      lpFee: z.number().int(),
      protocolFee: z.number().int(),
      sqrtPriceX96: RawAmountSchema,
      tick: z.number().int(),
      liquidity: RawAmountSchema,
    })
  ),
  poolDiscovery: z.enum(['input', 'subgraph', 'logs', 'none']),
  blockNumber: z.string(),
  takenAt: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// 11. build_swap
// ---------------------------------------------------------------------------

export const BuildSwapInputSchema = z.object({
  chainId: ChainIdSchema,
  swapper: AddressSchema,
  tokenIn: TokenInputSchema,
  tokenOut: TokenInputSchema,
  amount: DecimalStringSchema,
  type: TradeTypeSchema,
  slippagePct: SlippagePctSchema,
  /** Swap-and-send: output goes here instead of the swapper. */
  recipient: AddressSchema.optional(),
  ...resumeFields,
});

// ---------------------------------------------------------------------------
// 12. build_transfer
// ---------------------------------------------------------------------------

export const BuildTransferInputSchema = z.object({
  chainId: ChainIdSchema,
  from: AddressSchema,
  token: TokenInputSchema,
  amount: DecimalStringSchema,
  to: AddressSchema,
});

// ---------------------------------------------------------------------------
// 13. build_lp_position
// ---------------------------------------------------------------------------

export const RangeSchema = z.union([
  z.object({ preset: z.enum(['narrow', 'medium', 'wide']) }).strict(),
  z
    .object({
      /** token1 per token0, human units. */
      minPrice: DecimalStringSchema,
      maxPrice: DecimalStringSchema,
    })
    .strict(),
]);
export type RangeInput = z.infer<typeof RangeSchema>;

export const BuildLpPositionInputSchema = z.object({
  chainId: ChainIdSchema,
  owner: AddressSchema,
  /** Existing pools only (newPool is not supported). */
  pool: z
    .object({
      /** v4 poolId. */
      poolReference: Bytes32Schema,
      token0: TokenInputSchema,
      token1: TokenInputSchema,
    })
    .strict(),
  independentToken: z.object({ token: TokenInputSchema, amount: DecimalStringSchema }),
  range: RangeSchema,
  slippagePct: SlippagePctSchema,
  ...resumeFields,
});

// ---------------------------------------------------------------------------
// 14. build_lp_exit
// ---------------------------------------------------------------------------

export const BuildLpExitInputSchema = z.object({
  chainId: ChainIdSchema,
  owner: AddressSchema,
  protocol: z.literal('V4'),
  token0: TokenInputSchema,
  token1: TokenInputSchema,
  tokenId: z.string().regex(/^\d+$/),
  percent: z.number().int().min(1).max(100),
  claimFees: z.boolean(),
  slippagePct: SlippagePctSchema.optional(),
});

// ---------------------------------------------------------------------------
// 15. build_rebalance
// ---------------------------------------------------------------------------

export const BuildRebalanceInputSchema = z.object({
  chainId: ChainIdSchema,
  owner: AddressSchema,
  tokenId: z.string().regex(/^\d+$/),
  token0: TokenInputSchema,
  token1: TokenInputSchema,
  /** Target pool (v4 poolId). Same pool = re-range; a different pool = "move to a better pool". */
  poolReference: Bytes32Schema,
  newRange: RangeSchema,
  slippagePct: SlippagePctSchema.optional(),
});

export const BuildRebalanceOutputSchema = BuildResultSchema.extend({
  next: z.object({
    tool: z.literal('build_lp_position'),
    /** Arguments computed from the expected exit amounts; re-run with actual balances. */
    args: BuildLpPositionInputSchema.omit({ resumeToken: true, signature: true }),
    expected: z.object({ amount0: AmountSchema, amount1: AmountSchema }),
  }),
});

// ---------------------------------------------------------------------------
// 16. plan_trigger
// ---------------------------------------------------------------------------

const SymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.$_-]+$/);

/** "50%" of the holding, "$20" in USD, or "0.1" token units. */
export const AmountSpecSchema = z
  .string()
  .trim()
  .regex(
    /^((0|[1-9]\d*)(\.\d+)?%|\$(0|[1-9]\d*)(\.\d+)?|(0|[1-9]\d*)(\.\d+)?)$/,
    'Amount must be "50%", "$20" or a token amount like "0.1"'
  );

export const TriggerConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price_above'), symbol: SymbolSchema, priceUsd: DecimalStringSchema }),
  z.object({ type: z.literal('price_below'), symbol: SymbolSchema, priceUsd: DecimalStringSchema }),
  z.object({
    type: z.literal('price_change_pct'),
    symbol: SymbolSchema,
    /** Signed percent from the price now, e.g. 2 (+2%) or -5 (−5%). */
    pct: z.number().min(-99).max(1000),
    from: z.literal('now'),
  }),
  z.object({
    type: z.literal('schedule'),
    every: z.enum(['day', 'week']),
    atLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm (24h)'),
    dayOfWeek: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).optional(),
  }),
]);

export const TriggerActionTemplateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('swap_exact_in'),
    tokenIn: SymbolSchema,
    tokenOut: SymbolSchema,
    amountIn: AmountSpecSchema,
    maxSlippagePct: SlippagePctSchema.optional(),
  }),
  z.object({
    type: z.literal('swap_exact_out'),
    tokenIn: SymbolSchema,
    tokenOut: SymbolSchema,
    amountOut: DecimalStringSchema,
    maxSlippagePct: SlippagePctSchema.optional(),
  }),
  z.object({
    type: z.literal('lp_open'),
    token0: SymbolSchema,
    token1: SymbolSchema,
    /** Defaults to "100%" of what the previous step produced. */
    amount: AmountSpecSchema.optional(),
    rangePreset: z.enum(['narrow', 'medium', 'wide']),
  }),
  z.object({
    type: z.literal('transfer'),
    token: SymbolSchema,
    amount: AmountSpecSchema,
    recipient: AddressSchema,
  }),
]);

export const PlanTriggerInputSchema = z.object({
  kind: z.enum(['TAKE_PROFIT', 'STOP_LOSS', 'DCA', 'CHAINED', 'PRICE_ALERT']),
  condition: TriggerConditionSchema,
  actions: z.array(TriggerActionTemplateSchema).max(4),
  /** Reference USD prices by symbol; used for price_change_pct. Fetched from mainnet if absent. */
  referencePricesUsd: z.record(DecimalStringSchema).optional(),
});
export type PlanTriggerInput = z.infer<typeof PlanTriggerInputSchema>;

export const NormalizedAmountSchema = z.object({
  kind: z.enum(['percent', 'usd', 'absolute']),
  value: DecimalStringSchema,
});

export const TriggerSpecSchema = z.object({
  kind: z.enum(['TAKE_PROFIT', 'STOP_LOSS', 'DCA', 'CHAINED', 'PRICE_ALERT']),
  condition: z.object({
    type: z.enum(['price_above', 'price_below', 'schedule']),
    symbol: z.string().nullable(),
    targetPriceUsd: z.string().nullable(),
    referencePriceUsd: z.string().nullable(),
    changePct: z.number().nullable(),
    every: z.enum(['day', 'week']).nullable(),
    atLocalTime: z.string().nullable(),
    dayOfWeek: z.string().nullable(),
  }),
  actions: z.array(
    z.object({
      type: z.enum(['swap_exact_in', 'swap_exact_out', 'lp_open', 'transfer']),
      tokenIn: z.string().nullable(),
      tokenOut: z.string().nullable(),
      token: z.string().nullable(),
      token0: z.string().nullable(),
      token1: z.string().nullable(),
      recipient: AddressSchema.nullable(),
      amount: NormalizedAmountSchema,
      rangePreset: z.enum(['narrow', 'medium', 'wide']).nullable(),
      maxSlippagePct: z.number().nullable(),
    })
  ),
});
export type TriggerSpec = z.infer<typeof TriggerSpecSchema>;

export const PlanTriggerOutputSchema = z.object({
  spec: TriggerSpecSchema,
  humanSummary: z.string(),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export const TOOL_INPUT_SCHEMAS = {
  get_quote: GetQuoteInputSchema,
  quote_pool: QuotePoolInputSchema,
  get_portfolio: GetPortfolioInputSchema,
  get_price_history: GetPriceHistoryInputSchema,
  get_lp_positions: GetLpPositionsInputSchema,
  compare_pools: ComparePoolsInputSchema,
  check_token: CheckTokenInputSchema,
  list_new_hooks: ListNewHooksInputSchema,
  score_hook: ScoreHookInputSchema,
  get_hook_state: GetHookStateInputSchema,
  build_swap: BuildSwapInputSchema,
  build_transfer: BuildTransferInputSchema,
  build_lp_position: BuildLpPositionInputSchema,
  build_lp_exit: BuildLpExitInputSchema,
  build_rebalance: BuildRebalanceInputSchema,
  plan_trigger: PlanTriggerInputSchema,
} as const satisfies Record<ToolName, z.AnyZodObject>;

export const TOOL_OUTPUT_SCHEMAS = {
  get_quote: GetQuoteOutputSchema,
  quote_pool: QuotePoolOutputSchema,
  get_portfolio: GetPortfolioOutputSchema,
  get_price_history: GetPriceHistoryOutputSchema,
  get_lp_positions: GetLpPositionsOutputSchema,
  compare_pools: ComparePoolsOutputSchema,
  check_token: CheckTokenOutputSchema,
  list_new_hooks: ListNewHooksOutputSchema,
  score_hook: ScoreHookOutputSchema,
  get_hook_state: GetHookStateOutputSchema,
  build_swap: BuildResultSchema,
  build_transfer: BuildResultSchema,
  build_lp_position: BuildResultSchema,
  build_lp_exit: BuildResultSchema,
  build_rebalance: BuildRebalanceOutputSchema,
  plan_trigger: PlanTriggerOutputSchema,
} as const satisfies Record<ToolName, z.AnyZodObject>;

export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[N]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOL_OUTPUT_SCHEMAS)[N]>;
