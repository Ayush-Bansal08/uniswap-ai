/**
 * plan_trigger — validate and normalise a trigger spec from the planner into a canonical
 * TriggerSpec + humanSummary. Pure logic: the only network access is resolving a reference
 * price for `price_change_pct` when the caller did not pass `referencePricesUsd`.
 */
import type { z } from 'zod';
import { Decimal, formatUsd } from '../amounts.js';
import type { ToolDeps } from '../context.js';
import { invalidInput, McpToolError } from '../errors.js';
import {
  PlanTriggerInputSchema,
  PlanTriggerOutputSchema,
  type PlanTriggerInput,
  type TriggerSpec,
} from '../schemas.js';
import { getReferencePriceUsd } from '../services/prices.js';
import { defineTool } from './define.js';

type Action = PlanTriggerInput['actions'][number];
type NormalizedAction = TriggerSpec['actions'][number];
type Amount = NormalizedAction['amount'];

export function parseAmountSpec(spec: string, label: string): Amount {
  const s = spec.trim();
  if (s.endsWith('%')) {
    const value = new Decimal(s.slice(0, -1));
    if (value.lte(0) || value.gt(100))
      throw invalidInput(`${label}: percent must be in (0, 100], got ${s}`);
    return { kind: 'percent', value: value.toFixed() };
  }
  if (s.startsWith('$')) {
    const value = new Decimal(s.slice(1));
    if (value.lte(0)) throw invalidInput(`${label}: USD amount must be greater than 0`);
    return { kind: 'usd', value: value.toFixed() };
  }
  const value = new Decimal(s);
  if (value.lte(0)) throw invalidInput(`${label}: amount must be greater than 0`);
  return { kind: 'absolute', value: value.toFixed() };
}

function normalizeAction(action: Action, index: number): NormalizedAction {
  const base = {
    tokenIn: null,
    tokenOut: null,
    token: null,
    token0: null,
    token1: null,
    recipient: null,
    rangePreset: null,
    maxSlippagePct: null,
  };
  const label = `actions[${index}]`;
  switch (action.type) {
    case 'swap_exact_in':
      if (action.tokenIn.toUpperCase() === action.tokenOut.toUpperCase())
        throw invalidInput(`${label}: tokenIn and tokenOut must differ`);
      return {
        ...base,
        type: action.type,
        tokenIn: action.tokenIn.toUpperCase(),
        tokenOut: action.tokenOut.toUpperCase(),
        amount: parseAmountSpec(action.amountIn, `${label}.amountIn`),
        maxSlippagePct: action.maxSlippagePct ?? null,
      };
    case 'swap_exact_out':
      if (action.tokenIn.toUpperCase() === action.tokenOut.toUpperCase())
        throw invalidInput(`${label}: tokenIn and tokenOut must differ`);
      return {
        ...base,
        type: action.type,
        tokenIn: action.tokenIn.toUpperCase(),
        tokenOut: action.tokenOut.toUpperCase(),
        amount: parseAmountSpec(action.amountOut, `${label}.amountOut`),
        maxSlippagePct: action.maxSlippagePct ?? null,
      };
    case 'lp_open':
      if (action.token0.toUpperCase() === action.token1.toUpperCase())
        throw invalidInput(`${label}: token0 and token1 must differ`);
      return {
        ...base,
        type: action.type,
        token0: action.token0.toUpperCase(),
        token1: action.token1.toUpperCase(),
        amount: parseAmountSpec(action.amount ?? '100%', `${label}.amount`),
        rangePreset: action.rangePreset,
      };
    case 'transfer':
      return {
        ...base,
        type: action.type,
        token: action.token.toUpperCase(),
        recipient: action.recipient,
        amount: parseAmountSpec(action.amount, `${label}.amount`),
      };
  }
}

function describeAmount(a: Amount, symbol: string, ofWhat: string): string {
  if (a.kind === 'percent') return `${a.value}% of ${ofWhat}`;
  if (a.kind === 'usd') return `${formatUsd(a.value)} of ${symbol}`;
  return `${a.value} ${symbol}`;
}

function describeAction(a: NormalizedAction, index: number): string {
  switch (a.type) {
    case 'swap_exact_in':
      return a.amount.kind === 'percent'
        ? `sell ${a.amount.value}% of your ${a.tokenIn} for ${a.tokenOut}`
        : `swap ${describeAmount(a.amount, a.tokenIn!, `your ${a.tokenIn}`)} for ${a.tokenOut}`;
    case 'swap_exact_out':
      return `buy ${a.amount.value} ${a.tokenOut} with ${a.tokenIn}`;
    case 'lp_open':
      return `put ${
        index > 0 && a.amount.kind === 'percent'
          ? `${a.amount.value}% of the proceeds`
          : describeAmount(a.amount, a.token0!, 'your balance')
      } into ${a.token0}/${a.token1} (${a.rangePreset} range)`;
    case 'transfer':
      return `send ${describeAmount(a.amount, a.token!, `your ${a.token}`)} to ${a.recipient!.slice(
        0,
        6
      )}…${a.recipient!.slice(-4)}`;
  }
}

async function referencePrice(
  deps: ToolDeps,
  input: PlanTriggerInput,
  symbol: string
): Promise<string> {
  const supplied = input.referencePricesUsd
    ? Object.entries(input.referencePricesUsd).find(([k]) => k.toUpperCase() === symbol)?.[1]
    : undefined;
  if (supplied) return supplied;
  const fetched = await getReferencePriceUsd(deps, symbol);
  if (!fetched) {
    throw new McpToolError(
      'UNKNOWN_TOKEN',
      `No reference price for ${symbol}; pass referencePricesUsd.${symbol}`,
      { retryable: false }
    );
  }
  return fetched;
}

export async function planTrigger(input: PlanTriggerInput, deps: ToolDeps) {
  const warnings: string[] = [];
  const actions = input.actions.map(normalizeAction);
  const c = input.condition;

  let condition: TriggerSpec['condition'] = {
    type: 'schedule',
    symbol: null,
    targetPriceUsd: null,
    referencePriceUsd: null,
    changePct: null,
    every: null,
    atLocalTime: null,
    dayOfWeek: null,
  };
  if (c.type === 'price_above' || c.type === 'price_below') {
    if (new Decimal(c.priceUsd).lte(0))
      throw invalidInput('condition.priceUsd must be greater than 0');
    condition = {
      ...condition,
      type: c.type,
      symbol: c.symbol.toUpperCase(),
      targetPriceUsd: new Decimal(c.priceUsd).toFixed(),
    };
  } else if (c.type === 'price_change_pct') {
    if (c.pct === 0) throw invalidInput('condition.pct must not be 0');
    const symbol = c.symbol.toUpperCase();
    const ref = new Decimal(await referencePrice(deps, input, symbol));
    const target = ref.mul(new Decimal(100).plus(c.pct)).div(100).toDecimalPlaces(2);
    condition = {
      ...condition,
      type: c.pct > 0 ? 'price_above' : 'price_below',
      symbol,
      targetPriceUsd: target.toFixed(2),
      referencePriceUsd: ref.toDecimalPlaces(6).toFixed(),
      changePct: c.pct,
    };
  } else {
    if (c.every === 'week' && !c.dayOfWeek)
      throw invalidInput('condition.dayOfWeek is required when every is "week"');
    if (c.every === 'day' && c.dayOfWeek)
      warnings.push('dayOfWeek is ignored for a daily schedule');
    condition = {
      ...condition,
      type: 'schedule',
      every: c.every,
      atLocalTime: c.atLocalTime,
      dayOfWeek: c.every === 'week' ? c.dayOfWeek ?? null : null,
    };
  }

  const isPrice = condition.type !== 'schedule';
  const first = actions[0];
  switch (input.kind) {
    case 'PRICE_ALERT':
      if (!isPrice) throw invalidInput('PRICE_ALERT needs a price condition');
      if (actions.length > 0) throw invalidInput('PRICE_ALERT must not have actions');
      break;
    case 'TAKE_PROFIT':
    case 'STOP_LOSS': {
      if (!isPrice) throw invalidInput(`${input.kind} needs a price condition`);
      const wanted = input.kind === 'TAKE_PROFIT' ? 'price_above' : 'price_below';
      if (condition.type !== wanted) {
        throw invalidInput(
          `${input.kind} needs ${
            wanted === 'price_above'
              ? 'a price_above / positive pct'
              : 'a price_below / negative pct'
          } condition`
        );
      }
      if (actions.length !== 1)
        throw invalidInput(`${input.kind} takes exactly one action (use CHAINED for more)`);
      if (first!.type !== 'swap_exact_in' || first!.tokenIn !== condition.symbol) {
        throw invalidInput(
          `${input.kind} must sell the watched token (${condition.symbol}) with a swap_exact_in`
        );
      }
      break;
    }
    case 'DCA':
      if (condition.type !== 'schedule') throw invalidInput('DCA needs a schedule condition');
      if (actions.length !== 1 || first!.type !== 'swap_exact_in')
        throw invalidInput('DCA takes exactly one swap_exact_in action');
      if (first!.amount.kind === 'percent')
        throw invalidInput('DCA amounts must be fixed ("$20" or "0.01"), not a percent');
      break;
    case 'CHAINED':
      if (!isPrice) throw invalidInput('CHAINED needs a price condition');
      if (actions.length < 2) throw invalidInput('CHAINED needs 2–4 actions');
      if (
        actions
          .slice(1)
          .some(
            (a) =>
              a.type === 'swap_exact_in' &&
              a.amount.kind === 'percent' &&
              a.tokenIn === condition.symbol
          )
      ) {
        warnings.push(
          'Later steps sell a percent of the watched token again; percentages apply to the balance at that moment'
        );
      }
      break;
  }

  const spec: TriggerSpec = { kind: input.kind, condition, actions };
  return { spec, humanSummary: humanSummary(spec), warnings };
}

export function humanSummary(spec: TriggerSpec): string {
  const c = spec.condition;
  let when: string;
  if (c.type === 'schedule') {
    when =
      c.every === 'day'
        ? `every day at ${c.atLocalTime}`
        : `every ${c.dayOfWeek} at ${c.atLocalTime}`;
  } else {
    const op = c.type === 'price_above' ? '≥' : '≤';
    const pct = c.changePct !== null ? ` (${c.changePct > 0 ? '+' : ''}${c.changePct}%)` : '';
    when = `when ${c.symbol} ${op} ${formatUsd(c.targetPriceUsd!)}${pct}`;
  }
  if (spec.kind === 'PRICE_ALERT') return `Alert me ${when}`;
  const steps = spec.actions.map((a, i) => describeAction(a, i));
  const body =
    steps.length > 1
      ? `${steps.slice(0, -1).join(', then ')}, then ${steps.at(-1)}`
      : steps[0] ?? '';
  const sentence = `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
  return spec.kind === 'DCA' ? `${sentence} ${when}` : `${sentence} ${when}`;
}

export const planTriggerTool = defineTool({
  name: 'plan_trigger',
  title: 'Validate a trigger plan',
  description:
    'Validate and normalise a trigger (TAKE_PROFIT, STOP_LOSS, DCA, CHAINED, PRICE_ALERT) into a canonical TriggerSpec with a one-line humanSummary such as "Sell 50% of your ETH for USDC when ETH ≥ $3,312.40 (+2%)". Conditions: price_above / price_below (USD), price_change_pct from now (resolved to an absolute target with the reference price — pass referencePricesUsd or it is fetched from mainnet), or schedule (every day/week at HH:mm local). Action amounts: "50%" of the holding, "$20", or a token amount. Rejects invalid or ambiguous specs with precise errors. No transactions.',
  kind: 'plan',
  input: PlanTriggerInputSchema,
  output: PlanTriggerOutputSchema,
  handler: (args, deps) => planTrigger(args, deps),
  summarize: (o: z.infer<typeof PlanTriggerOutputSchema>) =>
    `${o.humanSummary}${o.warnings.length ? ` (warnings: ${o.warnings.join('; ')})` : ''}.`,
});
