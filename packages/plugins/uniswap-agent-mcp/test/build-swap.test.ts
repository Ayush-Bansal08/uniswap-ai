import { describe, expect, it } from 'vitest';
import {
  approvalResponse,
  PERMIT_SINGLE,
  quoteEthToUsdc,
  quoteUsdcToEthWithPermit,
  SWAP_CALLDATA,
  swapResponse,
} from './fixtures.js';
import {
  fail,
  harness,
  ok,
  OTHER,
  SEPOLIA,
  SEPOLIA_UR,
  SEPOLIA_USDC,
  SWAPPER,
  TRADE,
} from './helpers.js';

const SIG = `0x${'ab'.repeat(65)}`;

const ethIn = {
  chainId: SEPOLIA,
  swapper: SWAPPER,
  tokenIn: 'ETH',
  tokenOut: 'USDC',
  amount: '0.001',
  type: 'EXACT_INPUT',
  slippagePct: 0.5,
};
const usdcIn = { ...ethIn, tokenIn: 'USDC', tokenOut: 'ETH', amount: '20' };

describe('build_swap', () => {
  it('ETH in → READY with one SWAP step (no approval, no Permit2)', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { body: quoteEthToUsdc() });
    h.http.on('POST', `${TRADE}/swap`, { body: swapResponse() });
    const out = await ok(h, 'build_swap', ethIn);

    expect(out.status).toBe('READY');
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toEqual({
      kind: 'SWAP',
      description: 'Swap via Uniswap Universal Router',
      tx: {
        to: SEPOLIA_UR,
        from: SWAPPER,
        data: SWAP_CALLDATA,
        value: '1000000000000000',
        chainId: SEPOLIA,
        gasLimit: '250000',
      },
    });
    expect(out.summary).toMatchObject({
      amountIn: { decimal: '0.001' },
      amountOut: { decimal: '26.35' },
      priceImpactPct: 0.14,
    });
    expect(h.http.callsTo('/check_approval')).toHaveLength(0);
    // /swap gets the quote and NO permit fields (skill: both or neither).
    const swapBody = h.http.callsTo('/swap')[0]!.body as Record<string, unknown>;
    expect(Object.keys(swapBody)).toEqual(['quote']);
    expect(h.http.callsTo('/swap')[0]!.headers['x-universal-router-version']).toBe('2.1.2');
  });

  it('USDC in with Permit2 → NEEDS_SIGNATURE → finalize with signature → READY', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/check_approval`, { body: approvalResponse(true) });
    h.http.on('POST', `${TRADE}/quote`, { body: quoteUsdcToEthWithPermit() });
    h.http.on('POST', `${TRADE}/swap`, { body: swapResponse('0') });

    const first = await ok(h, 'build_swap', usdcIn);
    expect(first.status).toBe('NEEDS_SIGNATURE');
    expect(first.steps).toBeUndefined();
    expect(first.preSteps).toHaveLength(1);
    expect(first.preSteps[0]).toMatchObject({
      kind: 'APPROVAL',
      tx: { to: SEPOLIA_USDC, from: SWAPPER, value: '0', chainId: SEPOLIA },
    });
    expect(first.signature).toEqual({
      kind: 'PERMIT2',
      typedData: {
        domain: PERMIT_SINGLE.domain,
        types: PERMIT_SINGLE.types,
        primaryType: 'PermitSingle',
        message: PERMIT_SINGLE.values,
      },
    });
    expect(first.resumeToken).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(Date.parse(first.expiresAt) - h.clock.now).toBe(120_000);
    expect(h.http.callsTo('/check_approval')[0]!.body).toEqual({
      walletAddress: SWAPPER,
      token: SEPOLIA_USDC,
      amount: '20000000',
      chainId: SEPOLIA,
    });
    expect(h.http.callsTo('/swap')).toHaveLength(0);
    // The resume token holds only public data.
    const payload = Buffer.from(first.resumeToken.split('.')[0], 'base64url').toString('utf8');
    expect(payload).not.toContain('test-uniswap-key');
    expect(payload).not.toContain('test-resume-secret');

    h.clock.now += 60_000;
    const final = await ok(h, 'build_swap', {
      ...usdcIn,
      resumeToken: first.resumeToken,
      signature: SIG,
    });
    expect(final.status).toBe('READY');
    expect(final.steps.map((s: { kind: string }) => s.kind)).toEqual(['SWAP']);
    const swapBody = h.http.callsTo('/swap')[0]!.body as Record<string, unknown>;
    expect(swapBody.signature).toBe(SIG);
    expect(swapBody.permitData).toEqual(PERMIT_SINGLE);
    expect((swapBody.quote as { quoteId: string }).quoteId).toBe('q-usdc-eth');
    // No second quote: finalisation reuses the signed quote.
    expect(h.http.callsTo('/quote')).toHaveLength(1);
  });

  it('rejects a tampered resumeToken', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/check_approval`, { body: approvalResponse(false) });
    h.http.on('POST', `${TRADE}/quote`, { body: quoteUsdcToEthWithPermit() });
    const first = await ok(h, 'build_swap', usdcIn);
    const [payload, mac] = first.resumeToken.split('.');
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    json.data.quote.output.amount = '999999999999999999';
    const forged = `${Buffer.from(JSON.stringify(json)).toString('base64url')}.${mac}`;
    expect(
      await fail(h, 'build_swap', { ...usdcIn, resumeToken: forged, signature: SIG })
    ).toMatchObject({
      code: 'RESUME_TOKEN_INVALID',
      retryable: false,
    });
    expect(h.http.callsTo('/swap')).toHaveLength(0);
  });

  it('rejects an expired resumeToken and one replayed with different arguments', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/check_approval`, { body: approvalResponse(false) });
    h.http.on('POST', `${TRADE}/quote`, { body: quoteUsdcToEthWithPermit() });
    const first = await ok(h, 'build_swap', usdcIn);
    expect(
      await fail(h, 'build_swap', {
        ...usdcIn,
        amount: '2000',
        resumeToken: first.resumeToken,
        signature: SIG,
      })
    ).toMatchObject({
      code: 'RESUME_TOKEN_INVALID',
    });
    h.clock.now += 121_000;
    expect(
      await fail(h, 'build_swap', { ...usdcIn, resumeToken: first.resumeToken, signature: SIG })
    ).toMatchObject({
      code: 'RESUME_TOKEN_EXPIRED',
      retryable: true,
    });
  });

  it('requires resumeToken and signature together', async () => {
    const h = harness();
    expect(await fail(h, 'build_swap', { ...usdcIn, signature: SIG })).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('sends the custom recipient for swap-and-send', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { body: quoteEthToUsdc() });
    h.http.on('POST', `${TRADE}/swap`, { body: swapResponse() });
    const out = await ok(h, 'build_swap', { ...ethIn, recipient: OTHER });
    expect(h.http.callsTo('/quote')[0]!.body).toMatchObject({ swapper: SWAPPER, recipient: OTHER });
    expect(out.summary.recipient).toBe(OTHER);
  });

  it('refuses empty calldata, a wrong sender and an unexpected router', async () => {
    for (const [override, pattern] of [
      [{ data: '0x' }, /data is empty/],
      [{ from: OTHER }, /does not match the requested account/],
      [{ to: OTHER }, /unexpected target contract/],
      [{ chainId: 1 }, /does not match requested chain/],
    ] as const) {
      const h = harness();
      h.http.on('POST', `${TRADE}/quote`, { body: quoteEthToUsdc() });
      h.http.on('POST', `${TRADE}/swap`, { body: swapResponse('1000000000000000', override) });
      const err = await fail(h, 'build_swap', ethIn);
      expect(err.code).toBe('INVALID_TX');
      expect(err.message).toMatch(pattern);
    }
  });

  it('only builds on the execution chain', async () => {
    const h = harness();
    expect(await fail(h, 'build_swap', { ...ethIn, chainId: 1 })).toMatchObject({
      code: 'UNSUPPORTED_CHAIN',
    });
  });

  it('EXACT_OUTPUT approves the max input after quoting', async () => {
    const h = harness();
    const quote = quoteUsdcToEthWithPermit();
    quote.quote.tradeType = 'EXACT_OUTPUT';
    (quote.quote.input as Record<string, string>).maximumAmount = '20100000';
    quote.permitData = null as never;
    h.http.on('POST', `${TRADE}/quote`, { body: quote });
    h.http.on('POST', `${TRADE}/check_approval`, { body: approvalResponse(true) });
    h.http.on('POST', `${TRADE}/swap`, { body: swapResponse('0') });
    const out = await ok(h, 'build_swap', { ...usdcIn, type: 'EXACT_OUTPUT', amount: '0.00074' });
    expect(out.status).toBe('READY');
    expect(out.steps.map((s: { kind: string }) => s.kind)).toEqual(['APPROVAL', 'SWAP']);
    expect((h.http.callsTo('/check_approval')[0]!.body as { amount: string }).amount).toBe(
      '20100000'
    );
    expect(out.summary.maxAmountIn).toEqual({ raw: '20100000', decimal: '20.1' });
  });
});
