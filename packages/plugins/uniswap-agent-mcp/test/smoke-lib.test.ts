/** The live smoke runner, exercised offline against fixtures through a real MCP client. */
import { describe, expect, it } from 'vitest';
import { connectInProcess, coreSteps, exitCode, runSmoke } from '../scripts/smoke-lib.js';
import { mainnetEthPriceQuote, NOW_SEC, quoteEthToUsdc, subgraphResponse } from './fixtures.js';
import { ETH, GRAPH, harness, MAINNET_USDC, SEPOLIA, TRADE } from './helpers.js';

const GRAPH_URL = `${GRAPH}/test-graph-key/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`;
const HOOK = '0x0000000000000000000000000000000000000080';

describe('smoke runner (offline)', () => {
  it('runs the four PHASE 02 checks and feeds the first hook into score_hook', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, (req) => ({
      body:
        (req.body as { tokenInChainId: number }).tokenInChainId === 1
          ? mainnetEthPriceQuote()
          : quoteEthToUsdc(),
    }));
    const pool = {
      id: `0x${'0e'.repeat(32)}`,
      feeTier: '3000',
      tickSpacing: '60',
      hooks: HOOK,
      totalValueLockedUSD: '1000',
      createdAtTimestamp: String(NOW_SEC - 86_400),
      createdAtBlockNumber: '23600000',
      token0: { id: ETH, symbol: 'ETH', decimals: '18' },
      token1: { id: MAINNET_USDC.toLowerCase(), symbol: 'USDC', decimals: '6' },
    };
    h.http.on('POST', GRAPH_URL, { body: subgraphResponse({ pools: [pool] }) });
    h.main.code.set(HOOK, '0x6080604052');

    const client = await connectInProcess(h.deps);
    const steps = coreSteps(SEPOLIA);
    const lines: string[] = [];
    const results = await runSmoke(client, steps, (l) => lines.push(l));
    await client.close();

    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(exitCode(steps, results)).toBe(0);
    expect(lines.join('\n')).toMatch(/PASS {2}score_hook on the first market hook/);
    expect(lines.at(-1)).toContain('4/4 required checks passed');
  });

  it('fails the run when a required check fails', async () => {
    const h = harness();
    h.http.on('POST', `${TRADE}/quote`, { status: 404, body: { errorCode: 'NoRouteFoundError' } });
    h.http.on('POST', GRAPH_URL, { body: subgraphResponse({ pools: [] }) });
    const client = await connectInProcess(h.deps);
    const steps = coreSteps(SEPOLIA);
    const results = await runSmoke(client, steps, () => undefined);
    await client.close();
    expect(results[0]!.ok).toBe(false);
    expect(results[3]!.skipped).toBe(true);
    expect(exitCode(steps, results)).toBe(1);
  });
});
