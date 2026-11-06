/**
 * score_hook — deterministic hook safety score per the Uniswap v4 Security Framework and the
 * v4-security-foundations skill. See src/hooks/score.ts for every rule and its source section.
 */
import { getAddress } from 'viem';
import { requireReadableChain } from '../context.js';
import { ScoreHookInputSchema, ScoreHookOutputSchema } from '../schemas.js';
import { scoreHookCached } from '../services/hookFacts.js';
import { defineTool, short } from './define.js';

export const scoreHookTool = defineTool({
  name: 'score_hook',
  title: 'Score a v4 hook',
  description:
    'Deterministic safety score (0–100, band SAFE ≥80 / CAUTION ≥50 / DANGER) for a Uniswap v4 hook, following the Uniswap Foundation v4 Security Framework and the v4-security-foundations skill. Decodes permission flags from the address bits, then checks bytecode, codeHash, EIP-1967/1822/beacon/1167 proxies, owner() and privileged setters, verified source (Etherscan v2 when configured), age and pools (subgraph on mainnet, Initialize logs on the execution chain), dynamic fees and TVL. Returns permissions, facts, a per-rule breakdown with evidence and source, and the framework feature triggers. Read-only.',
  kind: 'read',
  input: ScoreHookInputSchema,
  output: ScoreHookOutputSchema,
  async handler(args, deps) {
    requireReadableChain(deps, args.chainId);
    return scoreHookCached(deps, args.chainId, getAddress(args.hookAddress));
  },
  summarize(o) {
    const top = o.breakdown.map((b) => `−${b.penalty} ${b.rule}`).join(', ');
    return `Hook ${short(o.hookAddress)} on chain ${o.chainId}: ${o.score}/100 (${o.band})${
      top ? ` — ${top}` : ' — no penalties'
    }. Enabled permissions: ${o.enabledPermissions.map((p) => p.flag).join(', ') || 'none'}.`;
  },
});
