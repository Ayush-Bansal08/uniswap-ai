import { describe, expect, it } from 'vitest';
import { McpToolError } from '../src/errors.js';
import { mainnetEthPriceQuote, NOW_SEC, subgraphResponse } from './fixtures.js';
import {
  ETH,
  fail,
  GRAPH,
  harness,
  MAINNET_USDC,
  ok,
  SEPOLIA,
  SEPOLIA_USDC,
  SWAPPER,
  TRADE,
} from './helpers.js';

const GRAPH_URL = `${GRAPH}/test-graph-key/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`;

describe('get_portfolio', () => {
  it('reads native + ERC-20 balances and prices them with mainnet reference quotes', async () => {
    const h = harness();
    h.exec.balances.set(SWAPPER.toLowerCase(), 250_000_000_000_000_000n); // 0.25 ETH
    h.exec.erc20.set(`${SWAPPER.toLowerCase()}:${SEPOLIA_USDC.toLowerCase()}`, 12_500_000n); // 12.5 USDC
    h.http.on('POST', `${TRADE}/quote`, { body: mainnetEthPriceQuote('3200000000') });

    const out = await ok(h, 'get_portfolio', { chainId: SEPOLIA, address: SWAPPER });
    const eth = out.tokens.find((t: { symbol: string }) => t.symbol === 'ETH');
    const usdc = out.tokens.find((t: { symbol: string }) => t.symbol === 'USDC');
    expect(eth).toMatchObject({
      balanceRaw: '250000000000000000',
      balance: '0.25',
      priceUsd: '3200',
      valueUsd: '800',
    });
    expect(usdc).toMatchObject({ balance: '12.5', priceUsd: '1', valueUsd: '12.5' });
    expect(out.totalUsd).toBe('812.5');
    expect(out.unpriced).toEqual([]);
    // Reference price came from a mainnet quote of 1 ETH → USDC.
    const [quote] = h.http.callsTo('/quote');
    expect(quote!.body).toMatchObject({
      tokenInChainId: 1,
      tokenIn: ETH,
      tokenOut: MAINNET_USDC,
      amount: '1000000000000000000',
    });
  });

  it('keeps balances but marks tokens unpriced when the reference quote fails', async () => {
    const h = harness();
    h.exec.balances.set(SWAPPER.toLowerCase(), 10n ** 18n);
    h.http.on('POST', `${TRADE}/quote`, { status: 404, body: { errorCode: 'NoRouteFoundError' } });
    const out = await ok(h, 'get_portfolio', { chainId: SEPOLIA, address: SWAPPER });
    expect(out.tokens.find((t: { symbol: string }) => t.symbol === 'ETH').priceUsd).toBeNull();
    expect(out.unpriced).toEqual(['ETH']);
    expect(out.totalUsd).toBe('0');
  });

  it('surfaces RPC failures as retryable RPC_ERROR', async () => {
    const h = harness();
    h.exec.erc20Balances = async () => {
      throw new McpToolError('RPC_ERROR', 'RPC (chain 11155111) multicall failed: timeout');
    };
    expect(await fail(h, 'get_portfolio', { chainId: SEPOLIA, address: SWAPPER })).toMatchObject({
      code: 'RPC_ERROR',
      retryable: true,
    });
  });
});

describe('get_price_history', () => {
  const ethPool = {
    id: '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27',
    feeTier: '500',
    tickSpacing: '10',
    hooks: '0x0000000000000000000000000000000000000000',
    totalValueLockedUSD: '150000000',
    createdAtTimestamp: '1733000000',
    createdAtBlockNumber: '21200000',
    token0: { id: ETH, symbol: 'ETH', decimals: '18' },
    token1: { id: MAINNET_USDC.toLowerCase(), symbol: 'USDC', decimals: '6' },
  };

  function routeSubgraph(
    h: ReturnType<typeof harness>,
    meta?: { number: number; timestamp: number },
    errors = false
  ) {
    h.http.on('POST', GRAPH_URL, (req) => {
      const query = (req.body as { query: string }).query;
      if (query.includes('poolHourDatas')) {
        return {
          body: subgraphResponse(
            {
              poolHourDatas: [
                {
                  periodStartUnix: NOW_SEC - 86_400 + 3_600,
                  token0Price: '0.0003125',
                  token1Price: '3200',
                },
                {
                  periodStartUnix: NOW_SEC - 43_200,
                  token0Price: '0.000303',
                  token1Price: '3300.5',
                },
                { periodStartUnix: NOW_SEC - 3_600, token0Price: '0.000306', token1Price: '3264' },
              ],
            },
            meta,
            errors
          ),
        };
      }
      return { body: subgraphResponse({ pools: [ethPool] }, meta, errors) };
    });
  }

  it('builds an ETH series from the deepest ETH/USDC v4 pool with stats and lag', async () => {
    const h = harness();
    routeSubgraph(h);
    const out = await ok(h, 'get_price_history', {
      symbol: 'eth',
      window: '24h',
      interval: 'hour',
    });
    expect(out.source).toMatchObject({ kind: 'pool', id: ethPool.id });
    expect(out.series.map((p: { priceUsd: string }) => p.priceUsd)).toEqual([
      '3200',
      '3300.5',
      '3264',
    ]);
    expect(out).toMatchObject({
      open: '3200',
      close: '3264',
      high: '3300.5',
      low: '3200',
      changePct: '2',
    });
    expect(out.asOf).toBe(new Date((NOW_SEC - 400) * 1000).toISOString());
    expect(out.lagSeconds).toBe(400);
    expect(out.stale).toBe(false);
    const sent = h.http.callsTo('/subgraphs/id/')[0]!.body as {
      variables: Record<string, unknown>;
    };
    expect(sent.variables).toMatchObject({ t0: ETH, t1: MAINNET_USDC.toLowerCase() });
  });

  it('flags stale data when the subgraph lags or has indexing errors', async () => {
    const h = harness();
    routeSubgraph(h, { number: 1, timestamp: NOW_SEC - 30_000 }, true);
    const out = await ok(h, 'get_price_history', {
      symbol: 'ETH',
      window: '24h',
      interval: 'hour',
    });
    expect(out.stale).toBe(true);
    expect(out.hasIndexingErrors).toBe(true);
  });

  it('reports subgraph failures as retryable SUBGRAPH_UNAVAILABLE', async () => {
    const h = harness();
    h.http.on('POST', GRAPH_URL, {
      body: { errors: [{ message: 'no attestation: indexing_error' }] },
    });
    expect(
      await fail(h, 'get_price_history', { symbol: 'ETH', window: '7d', interval: 'day' })
    ).toMatchObject({
      code: 'SUBGRAPH_UNAVAILABLE',
      retryable: true,
    });
  });

  it('rejects a daily interval over a 1h window', async () => {
    const h = harness();
    expect(
      await fail(h, 'get_price_history', { symbol: 'ETH', window: '1h', interval: 'day' })
    ).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
