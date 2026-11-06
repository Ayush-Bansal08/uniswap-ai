/**
 * quote_pool — "what-if" quote against ONE specific v4 pool via the V4Quoter contract
 * (`quoteExactInputSingle` / `quoteExactOutputSingle`, simulated with eth_call — never sent;
 * v4-sdk-integration skill "Quoting Pattern"). Used to compare a hook pool vs the default pool.
 */
import { getAddress, type Hex } from 'viem';
import { amountOf, toRaw } from '../amounts.js';
import { cacheKey, TTL } from '../cache.js';
import { getChain } from '../chains.js';
import { requireReadableChain } from '../context.js';
import { invalidInput, McpToolError } from '../errors.js';
import { QuotePoolInputSchema, QuotePoolOutputSchema } from '../schemas.js';
import { poolIdOf } from '../v4/math.js';
import { defineTool } from './define.js';

const MAX_UINT128 = (1n << 128n) - 1n;

export const quotePoolTool = defineTool({
  name: 'quote_pool',
  title: 'Quote one v4 pool (V4Quoter)',
  description:
    'Quote a single Uniswap v4 pool by its PoolKey using the official V4Quoter contract (eth_call simulation of quoteExactInputSingle / quoteExactOutputSingle). Use it to compare a specific hook pool against the default pool. exactAmount is a human decimal of the input (EXACT_INPUT) or output (EXACT_OUTPUT) token. Returns amounts, gas estimate and the poolId. Read-only.',
  kind: 'read',
  input: QuotePoolInputSchema,
  output: QuotePoolOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    const chain = getChain(args.chainId);
    const key = {
      currency0: getAddress(args.poolKey.currency0),
      currency1: getAddress(args.poolKey.currency1),
      fee: args.poolKey.fee,
      tickSpacing: args.poolKey.tickSpacing,
      hooks: getAddress(args.poolKey.hooks),
    };
    if (BigInt(key.currency0) >= BigInt(key.currency1)) {
      throw invalidInput('poolKey.currency0 must sort below currency1 (v4 currency order)');
    }
    const [token0, token1] = await Promise.all([
      deps.tokens.resolve(args.chainId, key.currency0),
      deps.tokens.resolve(args.chainId, key.currency1),
    ]);
    const tokenIn = args.zeroForOne ? token0 : token1;
    const tokenOut = args.zeroForOne ? token1 : token0;
    const exactToken = args.type === 'EXACT_INPUT' ? tokenIn : tokenOut;
    const exactAmount = toRaw(args.exactAmount, exactToken.decimals, 'exactAmount');
    if (exactAmount === 0n || exactAmount > MAX_UINT128)
      throw invalidInput('exactAmount must be in (0, 2^128)');
    const poolId = poolIdOf(args.chainId, token0, token1, key.fee, key.tickSpacing, key.hooks);
    const reader = deps.reader(args.chainId);
    const hookData = (args.hookData ?? '0x') as Hex;

    const result = await deps.cache.wrap(
      cacheKey('quote-pool', {
        chainId: args.chainId,
        key,
        z: args.zeroForOne,
        t: args.type,
        a: exactAmount.toString(),
        hookData,
      }),
      TTL.quote,
      async () => {
        try {
          const r = await reader.quoteExactSingle(chain.v4Quoter, args.type, {
            poolKey: key,
            zeroForOne: args.zeroForOne,
            exactAmount,
            hookData,
          });
          return { amount: r.amount.toString(), gasEstimate: r.gasEstimate.toString() };
        } catch (err) {
          if (err instanceof McpToolError && /revert/i.test(err.message)) {
            throw new McpToolError(
              'NO_ROUTE',
              `V4Quoter reverted for pool ${poolId}: the pool may not exist, be uninitialized, lack liquidity, or its hook rejected the swap.`,
              { retryable: false, details: { poolId } }
            );
          }
          throw err;
        }
      }
    );
    const quoted = BigInt(result.amount);
    const blockNumber = await reader
      .getBlockNumber()
      .then(String)
      .catch(() => null);
    return {
      chainId: args.chainId,
      poolId,
      poolKey: key,
      type: args.type,
      zeroForOne: args.zeroForOne,
      tokenIn,
      tokenOut,
      amountIn: amountOf(args.type === 'EXACT_INPUT' ? exactAmount : quoted, tokenIn.decimals),
      amountOut: amountOf(args.type === 'EXACT_INPUT' ? quoted : exactAmount, tokenOut.decimals),
      gasEstimate: result.gasEstimate,
      quoter: chain.v4Quoter,
      blockNumber,
    };
  },
  summarize(o) {
    return `V4Quoter on chain ${o.chainId}, pool ${o.poolId.slice(0, 10)}… (fee ${
      o.poolKey.fee
    }, hooks ${o.poolKey.hooks}): ${o.amountIn.decimal} ${o.tokenIn.symbol} → ${
      o.amountOut.decimal
    } ${o.tokenOut.symbol}, gas ≈ ${o.gasEstimate}.`;
  },
});
