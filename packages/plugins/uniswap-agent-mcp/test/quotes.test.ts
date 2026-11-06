import { describe, expect, it } from 'vitest';
import { quoteEthToUsdc, V4_ETH_USDC_POOL } from './fixtures.js';
import { ETH, fail, harness, ok, SEPOLIA, SEPOLIA_USDC, SWAPPER, TRADE } from './helpers.js';

const quoteArgs = {
  chainId: SEPOLIA,
  tokenIn: 'ETH',
  tokenOut: 'USDC',
  amount: '0.001',
  type: 'EXACT_INPUT',
  swapper: SWAPPER,
  slippagePct: 0.5,
};

describe('get_quote', () => {
  it('quotes CLASSIC via the Trading API with the skill headers and normalises the result', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { body: quoteEthToUsdc() });
    const out = await ok(h, 'get_quote', quoteArgs);

    expect(out.amountIn).toEqual({ raw: '1000000000000000', decimal: '0.001' });
    expect(out.amountOut).toEqual({ raw: '26350000', decimal: '26.35' });
    expect(out.minAmountOut).toEqual({ raw: '26218250', decimal: '26.21825' }); // 0.5% slippage
    expect(out.priceImpactPct).toBe(0.14);
    expect(out.gasFee).toEqual({ wei: '489108586810000', usd: '0.012' });
    expect(out.route.pools[0]).toMatchObject({
      protocol: 'V4',
      poolRef: V4_ETH_USDC_POOL,
      fee: 3000,
      tickSpacing: 60,
    });
    expect(out.route.hooks).toEqual([]);
    expect(out.quoteId).toBe('62e83902-9455-405d-8c62-cdf8ee9e2042');
    expect(Date.parse(out.expiresAt) - Date.parse(out.quotedAt)).toBe(30_000);

    const [call] = h.http.callsTo('/quote');
    expect(call!.headers['x-api-key']).toBe('test-uniswap-key');
    expect(call!.headers['x-universal-router-version']).toBe('2.1.2');
    expect(JSON.parse(call!.headers['x-agent-info']!)).toEqual({
      integration_name: 'swap-integration',
      decision_origin: 'autonomous',
      version: '1.6.0',
    });
    expect(call!.body).toMatchObject({
      type: 'EXACT_INPUT',
      amount: '1000000000000000',
      tokenInChainId: SEPOLIA,
      tokenOutChainId: SEPOLIA,
      tokenIn: ETH,
      tokenOut: SEPOLIA_USDC,
      protocols: ['V2', 'V3', 'V4'],
      routingPreference: 'BEST_PRICE',
      slippageTolerance: 0.5,
    });
  });

  it('caches identical quotes for 15 s', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { body: quoteEthToUsdc() });
    await ok(h, 'get_quote', quoteArgs);
    await ok(h, 'get_quote', quoteArgs);
    expect(h.http.callsTo('/quote')).toHaveLength(1);
    h.clock.now += 16_000;
    await ok(h, 'get_quote', quoteArgs);
    expect(h.http.callsTo('/quote')).toHaveLength(2);
  });

  it('maps NoRouteFoundError to NO_ROUTE (not retryable)', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, {
      status: 404,
      body: { errorCode: 'NoRouteFoundError', detail: 'No quotes available' },
    });
    const err = await fail(h, 'get_quote', quoteArgs);
    expect(err).toMatchObject({ code: 'NO_ROUTE', retryable: false });
    expect(err.message).toContain('NoRouteFoundError');
  });

  it('retries 5xx with backoff (max 3 retries) then reports a retryable upstream error', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { status: 503, body: { errorCode: 'ServiceUnavailable' } });
    const err = await fail(h, 'get_quote', quoteArgs);
    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(h.http.callsTo('/quote')).toHaveLength(4);
  });

  it('recovers when a retry succeeds after a 429', async () => {
    const h = harness();
    let n = 0;
    h.http.on('POST', `${TRADE}/quote`, () =>
      ++n === 1 ? { status: 429, body: { errorCode: 'Ratelimited' } } : { body: quoteEthToUsdc() }
    );
    const out = await ok(h, 'get_quote', quoteArgs);
    expect(out.amountOut.decimal).toBe('26.35');
    expect(n).toBe(2);
  });

  it('rejects unknown symbols, unsupported chains and too many decimals', async () => {
    const h = harness();
    expect(await fail(h, 'get_quote', { ...quoteArgs, tokenOut: 'PEPE' })).toMatchObject({
      code: 'UNKNOWN_TOKEN',
    });
    expect(await fail(h, 'get_quote', { ...quoteArgs, chainId: 137 })).toMatchObject({
      code: 'UNSUPPORTED_CHAIN',
    });
    expect(
      await fail(h, 'get_quote', {
        ...quoteArgs,
        tokenIn: 'USDC',
        tokenOut: 'ETH',
        amount: '1.0000001',
      })
    ).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses non-CLASSIC routing', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { body: { ...quoteEthToUsdc(), routing: 'DUTCH_V2' } });
    expect(await fail(h, 'get_quote', quoteArgs)).toMatchObject({ code: 'UNSUPPORTED_ROUTING' });
  });
});

describe('quote_pool', () => {
  const poolArgs = {
    chainId: SEPOLIA,
    poolKey: { currency0: ETH, currency1: SEPOLIA_USDC, fee: 3000, tickSpacing: 60, hooks: ETH },
    zeroForOne: true,
    exactAmount: '0.01',
    type: 'EXACT_INPUT',
  };

  it('quotes a single v4 pool through the V4Quoter (eth_call)', async () => {
    const h = harness();
    h.exec.quoteResult = { amount: 26_100_000n, gasEstimate: 95_000n };
    const out = await ok(h, 'quote_pool', poolArgs);
    expect(out.poolId).toBe(V4_ETH_USDC_POOL);
    expect(out.amountIn).toEqual({ raw: '10000000000000000', decimal: '0.01' });
    expect(out.amountOut).toEqual({ raw: '26100000', decimal: '26.1' });
    expect(out.gasEstimate).toBe('95000');
    expect(out.quoter).toBe('0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244');
  });

  it('maps a quoter revert to NO_ROUTE', async () => {
    const h = harness();
    const { McpToolError } = await import('../src/errors.js');
    h.exec.quoteResult = new McpToolError(
      'RPC_ERROR',
      'RPC (chain 11155111) V4Quoter failed: execution reverted'
    );
    expect(await fail(h, 'quote_pool', poolArgs)).toMatchObject({
      code: 'NO_ROUTE',
      retryable: false,
    });
  });

  it('rejects an unsorted pool key', async () => {
    const h = harness();
    const err = await fail(h, 'quote_pool', {
      ...poolArgs,
      poolKey: { ...poolArgs.poolKey, currency0: SEPOLIA_USDC, currency1: ETH },
    });
    expect(err.code).toBe('INVALID_INPUT');
  });
});
