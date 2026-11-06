import { describe, expect, it } from 'vitest';
import { depthFromImpact } from '../src/tools/check_token.js';
import { mainnetEthPriceQuote } from './fixtures.js';
import { fail, harness, ok, SEPOLIA, SEPOLIA_USDC, TRADE } from './helpers.js';

const UNSUPPORTED = 'https://unsupportedtokens.uniswap.org';
const SCAM = '0x2222222222222222222222222222222222222222';

describe('check_token', () => {
  it('passes allowlisted USDC with deep mainnet liquidity', async () => {
    const h = harness();
    h.http.on('GET', UNSUPPORTED, { body: { name: 'Unsupported', tokens: [] } });
    h.http.on('POST', `${TRADE}/quote`, {
      body: {
        ...mainnetEthPriceQuote(),
        quote: { ...mainnetEthPriceQuote().quote, priceImpact: 0.01 },
      },
    });
    const out = await ok(h, 'check_token', { chainId: SEPOLIA, token: 'USDC' });
    expect(out).toMatchObject({
      address: SEPOLIA_USDC,
      symbol: 'USDC',
      decimals: 6,
      onAllowlist: true,
      onUniswapUnsupportedList: false,
      isContract: true,
      hasQuote: true,
      liquidityDepthUsd: '10000000',
      verdict: 'OK',
      riskFlags: [],
    });
    expect(out.liquidityProbe.chainId).toBe(1);
  });

  it('blocks a token on the Uniswap unsupported list with no route', async () => {
    const h = harness();
    h.exec.code.set(SCAM, '0x6080604052');
    h.exec.metadataByToken.set(SCAM, { symbol: 'SCAM', name: 'Scam', decimals: 18 });
    h.http.on('GET', UNSUPPORTED, { body: { tokens: [{ chainId: SEPOLIA, address: SCAM }] } });
    h.http.on('POST', `${TRADE}/quote`, { status: 404, body: { errorCode: 'NoRouteFoundError' } });
    const out = await ok(h, 'check_token', { chainId: SEPOLIA, token: SCAM });
    expect(out.verdict).toBe('BLOCK');
    expect(out.riskFlags).toEqual(
      expect.arrayContaining(['NOT_ON_ALLOWLIST', 'ON_UNISWAP_UNSUPPORTED_LIST', 'NO_QUOTE'])
    );
  });

  it('blocks an address with no contract code', async () => {
    const h = harness();
    h.http.on('GET', UNSUPPORTED, { status: 500, body: {} });
    const out = await ok(h, 'check_token', {
      chainId: SEPOLIA,
      token: '0x3333333333333333333333333333333333333333',
    });
    expect(out.verdict).toBe('BLOCK');
    expect(out.isContract).toBe(false);
    expect(out.riskFlags).toEqual(
      expect.arrayContaining(['NOT_A_CONTRACT', 'UNSUPPORTED_LIST_UNAVAILABLE'])
    );
  });

  it('rejects an unknown symbol', async () => {
    const h = harness();
    expect(await fail(h, 'check_token', { chainId: SEPOLIA, token: 'DOGE' })).toMatchObject({
      code: 'UNKNOWN_TOKEN',
    });
  });

  it('estimates depth from price impact', () => {
    expect(depthFromImpact(1000, 1)).toBe('100000');
    expect(depthFromImpact(1000, 0)).toBe('1000000000');
    expect(depthFromImpact(1000, null)).toBeNull();
  });
});
