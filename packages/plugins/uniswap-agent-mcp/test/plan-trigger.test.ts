import { describe, expect, it } from 'vitest';
import { mainnetEthPriceQuote } from './fixtures.js';
import { fail, harness, ok, OTHER, TRADE } from './helpers.js';

const sellHalf = { type: 'swap_exact_in', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '50%' };

describe('plan_trigger', () => {
  it('TAKE_PROFIT +2% resolves the absolute target from the supplied reference price', async () => {
    const h = harness();
    const out = await ok(h, 'plan_trigger', {
      kind: 'TAKE_PROFIT',
      condition: { type: 'price_change_pct', symbol: 'eth', pct: 2, from: 'now' },
      actions: [sellHalf],
      referencePricesUsd: { ETH: '3247.45' },
    });
    expect(out.spec.condition).toMatchObject({
      type: 'price_above',
      symbol: 'ETH',
      targetPriceUsd: '3312.40',
      referencePriceUsd: '3247.45',
      changePct: 2,
    });
    expect(out.spec.actions[0]).toMatchObject({
      type: 'swap_exact_in',
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amount: { kind: 'percent', value: '50' },
    });
    expect(out.humanSummary).toBe('Sell 50% of your ETH for USDC when ETH ≥ $3,312.40 (+2%)');
    expect(h.http.calls).toHaveLength(0); // pure: no network when the price is supplied
  });

  it('fetches the reference price from mainnet when not supplied', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { body: mainnetEthPriceQuote('3000000000') });
    const out = await ok(h, 'plan_trigger', {
      kind: 'STOP_LOSS',
      condition: { type: 'price_change_pct', symbol: 'ETH', pct: -5, from: 'now' },
      actions: [{ ...sellHalf, amountIn: '100%' }],
    });
    expect(out.spec.condition).toMatchObject({ type: 'price_below', targetPriceUsd: '2850.00' });
    expect(out.humanSummary).toBe('Sell 100% of your ETH for USDC when ETH ≤ $2,850.00 (-5%)');
  });

  it('STOP_LOSS with an absolute price', async () => {
    const h = harness();
    const out = await ok(h, 'plan_trigger', {
      kind: 'STOP_LOSS',
      condition: { type: 'price_below', symbol: 'ETH', priceUsd: '2900' },
      actions: [sellHalf],
    });
    expect(out.spec.condition).toMatchObject({
      type: 'price_below',
      targetPriceUsd: '2900',
      changePct: null,
    });
  });

  it('DCA on a weekly schedule with a USD amount', async () => {
    const h = harness();
    const out = await ok(h, 'plan_trigger', {
      kind: 'DCA',
      condition: { type: 'schedule', every: 'week', atLocalTime: '09:30', dayOfWeek: 'mon' },
      actions: [{ type: 'swap_exact_in', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '$20' }],
    });
    expect(out.spec.condition).toMatchObject({
      type: 'schedule',
      every: 'week',
      atLocalTime: '09:30',
      dayOfWeek: 'mon',
      symbol: null,
    });
    expect(out.spec.actions[0].amount).toEqual({ kind: 'usd', value: '20' });
    expect(out.humanSummary).toBe('Swap $20.00 of USDC for ETH every mon at 09:30');
  });

  it('CHAINED: sell then LP the proceeds', async () => {
    const h = harness();
    const out = await ok(h, 'plan_trigger', {
      kind: 'CHAINED',
      condition: { type: 'price_above', symbol: 'ETH', priceUsd: '3500' },
      actions: [
        sellHalf,
        { type: 'lp_open', token0: 'ETH', token1: 'USDC', rangePreset: 'medium' },
      ],
    });
    expect(out.spec.actions).toHaveLength(2);
    expect(out.spec.actions[1]).toMatchObject({
      type: 'lp_open',
      amount: { kind: 'percent', value: '100' },
      rangePreset: 'medium',
    });
    expect(out.humanSummary).toBe(
      'Sell 50% of your ETH for USDC, then put 100% of the proceeds into ETH/USDC (medium range) when ETH ≥ $3,500.00'
    );
  });

  it('PRICE_ALERT has no actions', async () => {
    const h = harness();
    const out = await ok(h, 'plan_trigger', {
      kind: 'PRICE_ALERT',
      condition: { type: 'price_above', symbol: 'ETH', priceUsd: '4000' },
      actions: [],
    });
    expect(out.humanSummary).toBe('Alert me when ETH ≥ $4,000.00');
  });

  it.each([
    [
      'TP with a falling condition',
      {
        kind: 'TAKE_PROFIT',
        condition: { type: 'price_below', symbol: 'ETH', priceUsd: '2000' },
        actions: [sellHalf],
      },
      /price_above/,
    ],
    [
      'TP selling another token',
      {
        kind: 'TAKE_PROFIT',
        condition: { type: 'price_above', symbol: 'ETH', priceUsd: '4000' },
        actions: [{ ...sellHalf, tokenIn: 'USDC', tokenOut: 'ETH' }],
      },
      /must sell the watched token/,
    ],
    [
      'DCA with a percent',
      {
        kind: 'DCA',
        condition: { type: 'schedule', every: 'day', atLocalTime: '08:00' },
        actions: [sellHalf],
      },
      /fixed/,
    ],
    [
      'DCA on a price',
      {
        kind: 'DCA',
        condition: { type: 'price_above', symbol: 'ETH', priceUsd: '1' },
        actions: [sellHalf],
      },
      /schedule/,
    ],
    [
      'weekly without a day',
      {
        kind: 'DCA',
        condition: { type: 'schedule', every: 'week', atLocalTime: '08:00' },
        actions: [{ ...sellHalf, amountIn: '$5' }],
      },
      /dayOfWeek/,
    ],
    [
      'CHAINED with one step',
      {
        kind: 'CHAINED',
        condition: { type: 'price_above', symbol: 'ETH', priceUsd: '1' },
        actions: [sellHalf],
      },
      /2–4/,
    ],
    [
      'alert with actions',
      {
        kind: 'PRICE_ALERT',
        condition: { type: 'price_above', symbol: 'ETH', priceUsd: '1' },
        actions: [sellHalf],
      },
      /must not have actions/,
    ],
    [
      'percent over 100',
      {
        kind: 'STOP_LOSS',
        condition: { type: 'price_below', symbol: 'ETH', priceUsd: '1' },
        actions: [{ ...sellHalf, amountIn: '150%' }],
      },
      /\(0, 100\]/,
    ],
    [
      'zero pct change',
      {
        kind: 'TAKE_PROFIT',
        condition: { type: 'price_change_pct', symbol: 'ETH', pct: 0, from: 'now' },
        actions: [sellHalf],
        referencePricesUsd: { ETH: '1' },
      },
      /must not be 0/,
    ],
  ])('rejects %s', async (_name, args, message) => {
    const h = harness();
    const err = await fail(h, 'plan_trigger', args);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(message);
  });

  it('accepts transfer templates with a recipient', async () => {
    const h = harness();
    const out = await ok(h, 'plan_trigger', {
      kind: 'CHAINED',
      condition: { type: 'price_above', symbol: 'ETH', priceUsd: '5000' },
      actions: [sellHalf, { type: 'transfer', token: 'USDC', amount: '100%', recipient: OTHER }],
    });
    expect(out.spec.actions[1]).toMatchObject({
      type: 'transfer',
      recipient: OTHER,
      amount: { kind: 'percent', value: '100' },
    });
  });
});
