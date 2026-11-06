/**
 * build_swap — UNSIGNED swap transactions via the Trading API, following the swap-integration
 * skill's request flow:
 *   1. POST /check_approval  (ERC-20 input only; native ETH needs no approval or Permit2)
 *   2. POST /quote           (CLASSIC; `recipient` for swap-and-send)
 *   3. permitData present and no signature yet → NEEDS_SIGNATURE (approvals as preSteps,
 *      Permit2 typed data, HMAC resumeToken carrying the quote)
 *   4. POST /swap            ({ quote, permitData + signature together, or neither }) → READY
 * Every tx is validated (src/tx.ts); calldata is passed through untouched.
 */
import { getAddress, type Address } from 'viem';
import { toRaw } from '../amounts.js';
import { universalRouterFor } from '../chains.js';
import type {
  ClassicQuote,
  CreateSwapRequest,
  Permit,
  QuoteResponse,
} from '../clients/tradingApi.js';
import { requireExecutionChain, type ToolDeps } from '../context.js';
import { invalidInput } from '../errors.js';
import {
  BuildResultSchema,
  BuildSwapInputSchema,
  type BuildResultObject,
  type BuildSummary,
  type TokenInfo,
  type TxStep,
} from '../schemas.js';
import { fetchClassicQuote, normalizeQuote, type ClassicQuoteParams } from '../services/quote.js';
import { normalizePermit } from '../services/typedData.js';
import { validateTx } from '../tx.js';
import { defineTool, short } from './define.js';

interface SwapResume {
  quote: ClassicQuote;
  permitData: Permit;
  summary: BuildSummary;
}

async function approvalSteps(
  deps: ToolDeps,
  chainId: number,
  swapper: Address,
  token: TokenInfo,
  amount: bigint
): Promise<TxStep[]> {
  if (token.isNative) return [];
  const res = await deps.trading.checkApproval({
    walletAddress: swapper,
    token: token.address,
    amount: amount.toString(),
    chainId: chainId as never,
  });
  const expect = { chainId, from: swapper, allowedTo: [token.address] };
  const steps: TxStep[] = [];
  // Some tokens (e.g. USDT) need the allowance reset to 0 first: `cancel` comes before `approval`.
  if (res.cancel)
    steps.push(validateTx('APPROVAL', `Reset ${token.symbol} allowance to 0`, res.cancel, expect));
  if (res.approval)
    steps.push(
      validateTx('APPROVAL', `Approve ${token.symbol} for Permit2 (Uniswap)`, res.approval, expect)
    );
  return steps;
}

function swapSummary(
  deps: ToolDeps,
  params: ClassicQuoteParams,
  response: QuoteResponse,
  quote: ClassicQuote
): BuildSummary {
  const q = normalizeQuote(deps, params, response, quote);
  const single = q.route.pools.length === 1 ? q.route.pools[0] : undefined;
  return {
    tokenIn: q.tokenIn,
    tokenOut: q.tokenOut,
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    ...(q.minAmountOut ? { minAmountOut: q.minAmountOut } : {}),
    ...(q.maxAmountIn ? { maxAmountIn: q.maxAmountIn } : {}),
    ...(q.priceImpactPct !== null ? { priceImpactPct: q.priceImpactPct } : {}),
    ...(q.gasFee.wei ? { gasEstimateWei: q.gasFee.wei } : {}),
    ...(q.gasFee.usd ? { gasFeeUsd: q.gasFee.usd } : {}),
    ...(q.route.summary ? { route: q.route.summary } : {}),
    ...(single ? { poolRef: single.poolRef } : {}),
    ...(q.route.hooks[0] ? { hookAddress: q.route.hooks[0] } : {}),
    ...(params.recipient ? { recipient: params.recipient } : {}),
  };
}

async function finalizeSwap(
  deps: ToolDeps,
  chainId: number,
  swapper: Address,
  body: CreateSwapRequest
): Promise<TxStep> {
  const res = await deps.trading.swap(body);
  const router = universalRouterFor(
    chainId,
    deps.trading.universalRouterVersion as '2.1.2' | '2.2.0'
  );
  return validateTx('SWAP', 'Swap via Uniswap Universal Router', res.swap, {
    chainId,
    from: swapper,
    ...(router ? { allowedTo: [router] } : {}),
  });
}

export const buildSwapTool = defineTool({
  name: 'build_swap',
  title: 'Build an unsigned swap',
  description:
    'Build UNSIGNED swap transactions with the Uniswap Trading API (/check_approval → /quote → /swap, CLASSIC routing). Never signs or broadcasts. Returns READY steps (approvals, then the swap) or, when the quote needs a Permit2 signature, NEEDS_SIGNATURE with approval preSteps, EIP-712 typed data and a resumeToken (valid 120 s): run the preSteps, sign the typed data, then call build_swap again with the SAME arguments plus resumeToken and signature to get the READY swap. Native ETH input needs no approval or Permit2. Set recipient to swap-and-send.',
  kind: 'build',
  input: BuildSwapInputSchema,
  output: BuildResultSchema,
  async handler(args, deps): Promise<BuildResultObject> {
    requireExecutionChain(deps, args.chainId);
    const swapper = getAddress(args.swapper);
    const chainId = args.chainId;

    if (args.resumeToken || args.signature) {
      if (!args.resumeToken || !args.signature)
        throw invalidInput('resumeToken and signature must be sent together');
      const data = deps.resume.verify<SwapResume>('build_swap', args, args.resumeToken);
      // CLASSIC: signature and permitData go together (skill "Permit2 Field Rules").
      const step = await finalizeSwap(deps, chainId, swapper, {
        quote: data.quote,
        permitData: data.permitData,
        signature: args.signature,
      });
      return { status: 'READY', steps: [step], summary: data.summary };
    }

    const [tokenIn, tokenOut] = await Promise.all([
      deps.tokens.resolve(chainId, args.tokenIn),
      deps.tokens.resolve(chainId, args.tokenOut),
    ]);
    if (tokenIn.address === tokenOut.address)
      throw invalidInput('tokenIn and tokenOut must differ');
    const recipient = args.recipient ? getAddress(args.recipient) : undefined;
    const exact = args.type === 'EXACT_INPUT' ? tokenIn : tokenOut;
    const params: ClassicQuoteParams = {
      chainId,
      tokenIn,
      tokenOut,
      amountRaw: toRaw(args.amount, exact.decimals),
      type: args.type,
      swapper,
      slippagePct: args.slippagePct,
      ...(recipient && recipient !== swapper ? { recipient } : {}),
    };

    // Exact input: approval amount is known up front (skill order: check_approval → quote).
    let preSteps: TxStep[] =
      args.type === 'EXACT_INPUT'
        ? await approvalSteps(deps, chainId, swapper, tokenIn, params.amountRaw)
        : [];
    const { response, quote } = await fetchClassicQuote(deps, params);
    const summary = swapSummary(deps, params, response, quote);
    if (args.type === 'EXACT_OUTPUT') {
      // Exact output: approve the maximum input after slippage, known only after quoting.
      const maxIn = BigInt(summary.maxAmountIn?.raw ?? summary.amountIn?.raw ?? '0');
      preSteps = await approvalSteps(deps, chainId, swapper, tokenIn, maxIn);
    }

    const permit = response.permitData;
    if (permit && typeof permit === 'object' && Object.keys(permit).length > 0) {
      const signature = normalizePermit('PERMIT2', permit, chainId);
      const { token, expiresAt } = deps.resume.issue<SwapResume>('build_swap', args, {
        quote,
        permitData: permit,
        summary,
      });
      return {
        status: 'NEEDS_SIGNATURE',
        preSteps,
        signature,
        resumeToken: token,
        expiresAt,
        summary,
      };
    }

    // No Permit2 signature needed (native input or permit already in place): omit both fields.
    const swapStep = await finalizeSwap(deps, chainId, swapper, { quote });
    return { status: 'READY', steps: [...preSteps, swapStep], summary };
  },
  summarize(o) {
    const s = o.summary;
    const what = `${s.amountIn?.decimal ?? '?'} ${s.tokenIn?.symbol ?? ''} → ${
      s.amountOut?.decimal ?? '?'
    } ${s.tokenOut?.symbol ?? ''}`;
    if (o.status === 'NEEDS_SIGNATURE') {
      return `Swap ${what}: needs a Permit2 signature (${
        o.preSteps?.length ?? 0
      } approval tx first). Sign signature.typedData, then call build_swap again with the same args + resumeToken + signature before ${
        o.expiresAt
      }.`;
    }
    return `Swap ${what} ready: ${o.steps?.length ?? 0} unsigned tx (${o.steps
      ?.map((st) => st.kind)
      .join(' → ')})${s.recipient ? `, output to ${short(s.recipient)}` : ''}${
      s.minAmountOut ? `, min out ${s.minAmountOut.decimal}` : ''
    }.`;
  },
});
