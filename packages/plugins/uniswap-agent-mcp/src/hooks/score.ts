/**
 * Deterministic hook safety score (0–100) — pure function of on-chain facts.
 *
 * Sources (vendored):
 *   [F] docs/vendor/uniswap-v4-security-framework.md (Uniswap Foundation Security Framework)
 *   [K] uniswap-ai/packages/plugins/uniswap-hooks/skills/v4-security-foundations/SKILL.md
 *
 * The framework is a *self-assessment* for hook developers: nine 0–3/0–5 dimensions summed to
 * 0–33 (§2) mapped to tiers (§3), plus feature triggers (§4). It does not define a 0–100 score or
 * per-feature point weights, so the 100-point score below applies the PHASE 02 minimum penalty
 * set — each rule mapped to the framework/skill section it implements — and we report the
 * framework's own artefacts alongside it: §4 feature triggers with their minimum actions, and
 * the skill's "Risk Scoring System" restricted to what is observable on-chain.
 *
 * Bands follow the product thresholds: SAFE ≥ 80, CAUTION ≥ 50, else DANGER.
 */
import type { HookFacts, HookPermissions, ScoreHookOutput } from '../schemas.js';
import { enabledPermissions, PERMISSION_RISK, RETURN_DELTA_FLAGS } from './permissions.js';

export const HOOK_BAND_THRESHOLDS = Object.freeze({ safeMin: 80, cautionMin: 50 });

export const PENALTIES = Object.freeze({
  noCode: 100,
  returnDeltaEach: 25,
  returnDeltaCap: 40,
  upgradeableProxy: 20,
  privilegedOwner: 15,
  unverifiedSource: 15,
  youngHook: 10,
  youngHookDays: 7,
  dynamicFee: 5,
  highRiskCallbackEach: 5,
  highRiskCallbackCap: 10,
});

/** TVL ≥ $50M = "TVL potential 5" ([F] §2 "Suggested Scoring Brackets"). */
const TVL_5_USD = 50_000_000;

export function bandFor(score: number, hasCode: boolean): ScoreHookOutput['band'] {
  if (!hasCode) return 'DANGER';
  if (score >= HOOK_BAND_THRESHOLDS.safeMin) return 'SAFE';
  if (score >= HOOK_BAND_THRESHOLDS.cautionMin) return 'CAUTION';
  return 'DANGER';
}

type Breakdown = ScoreHookOutput['breakdown'];

export function computeHookScore(input: {
  chainId: number;
  hookAddress: string;
  permissions: HookPermissions;
  facts: HookFacts;
  now: Date;
}): ScoreHookOutput {
  const { permissions: p, facts } = input;
  const breakdown: Breakdown = [];
  const add = (rule: string, penalty: number, evidence: string, source: string) => {
    if (penalty > 0) breakdown.push({ rule, penalty, evidence, source });
  };

  // No code: nothing executes the declared callbacks → every call to the pool reverts or is undefined.
  if (!facts.hasCode) {
    add(
      'no_code',
      PENALTIES.noCode,
      'No bytecode at the hook address',
      '[K] Threat Model; [F] §1 Permission encoding — permissions with no implementation'
    );
  }

  // Return-delta permissions: NoOp / value-extraction surface.
  const deltas = RETURN_DELTA_FLAGS.filter((f) => p[f]);
  if (deltas.length > 0) {
    add(
      'return_delta_permissions',
      Math.min(deltas.length * PENALTIES.returnDeltaEach, PENALTIES.returnDeltaCap),
      `Enabled: ${deltas.join(', ')} (${deltas.map((f) => PERMISSION_RISK[f]).join('/')})`,
      '[F] §1 "BeforeSwapDelta and NoOp override risks"; [K] "Permission Flags Risk Matrix", "CRITICAL: NoOp Rug Pull Attack"'
    );
  }

  // Non-delta HIGH callbacks (can trap funds / manipulate prices).
  const highCallbacks = (['beforeSwap', 'beforeRemoveLiquidity'] as const).filter((f) => p[f]);
  if (highCallbacks.length > 0) {
    add(
      'high_risk_callbacks',
      Math.min(
        highCallbacks.length * PENALTIES.highRiskCallbackEach,
        PENALTIES.highRiskCallbackCap
      ),
      `Enabled HIGH-risk callbacks: ${highCallbacks.join(', ')}`,
      '[K] "Permission Flags Risk Matrix" (beforeSwap: can manipulate prices; beforeRemoveLiquidity: can trap user funds)'
    );
  }

  if (facts.proxy.upgradeable) {
    add(
      'upgradeable_proxy',
      PENALTIES.upgradeableProxy,
      `${facts.proxy.kind} proxy${
        facts.proxy.implementation ? ` → ${facts.proxy.implementation}` : ''
      }${facts.proxy.admin ? `, admin ${facts.proxy.admin}` : ''}`,
      '[F] §1 "Upgradeability hazards"; §4 "Upgradeable"; [K] Risk Scoring "Upgrade Mechanism"'
    );
  }

  const privileged = facts.owner ?? facts.proxy.admin;
  if (privileged && facts.adminSelectors.length > 0) {
    add(
      'privileged_owner_can_change_params',
      PENALTIES.privilegedOwner,
      `Privileged account ${privileged}; setter selectors in bytecode: ${facts.adminSelectors.join(
        ', '
      )}`,
      '[F] §1 "Autonomous behavior or parameter updates", §7 "Core controls" (minimal access control)'
    );
  }

  if (facts.verifiedSource !== true) {
    add(
      'unverified_source',
      PENALTIES.unverifiedSource,
      facts.verifiedSource === false
        ? 'Source code is not verified on the block explorer'
        : 'Source verification unknown (no ETHERSCAN_API_KEY or lookup failed) — scored conservatively',
      '[F] §7 "Transparency requirements"; §2 "evaluate each dimension honestly and conservatively"'
    );
  }

  if (facts.ageDays !== null && facts.ageDays < PENALTIES.youngHookDays) {
    add(
      'young_hook',
      PENALTIES.youngHook,
      `First seen ${facts.ageDays.toFixed(1)} days ago (${facts.ageSource ?? 'unknown source'})`,
      '[F] §1 "TVL growth over time", §2 "Team maturity" (no track record yet)'
    );
  }

  if ((facts.dynamicFeePoolCount ?? 0) > 0) {
    add(
      'dynamic_fee_pool',
      PENALTIES.dynamicFee,
      `${facts.dynamicFeePoolCount} pool(s) use the dynamic-fee flag`,
      '[F] §1 "Price impacting behavior and dynamic fees"'
    );
  }

  const total = breakdown.reduce((sum, b) => sum + b.penalty, 0);
  const score = Math.max(0, Math.min(100, 100 - total));

  return {
    chainId: input.chainId,
    hookAddress: input.hookAddress,
    score,
    band: bandFor(score, facts.hasCode),
    permissions: p,
    enabledPermissions: enabledPermissions(p),
    facts,
    breakdown,
    framework: {
      featureTriggers: featureTriggers(p, facts),
      riskScore: observableRiskScore(p, facts),
    },
    scoredAt: input.now.toISOString(),
  };
}

/** [F] §4 "Feature-Specific Security Recommendations" — minimum actions copied from the doc. */
function featureTriggers(p: HookPermissions, facts: HookFacts) {
  const dynamic = (facts.dynamicFeePoolCount ?? 0) > 0;
  const tvl = facts.tvlUsd !== null ? Number(facts.tvlUsd) : null;
  return [
    {
      feature: 'Custom curve or non standard math',
      triggered: p.beforeSwapReturnDelta,
      evidence: p.beforeSwapReturnDelta
        ? 'beforeSwapReturnDelta enables NoOp swaps / custom curves (§1)'
        : 'No beforeSwapReturnDelta permission',
      minimumActions: [
        'At least one audit should include a math and invariants specialist',
        'Unit tests should validate intermediate steps, edge cases, and input-range boundaries',
        'Stateful fuzzing and invariant testing may significantly improve assurance',
      ],
    },
    {
      feature: 'Hook holds its own liquidity or manages external liquidity',
      triggered: p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta,
      evidence:
        p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta
          ? 'Liquidity return-delta permissions let the hook take or pay part of LP amounts'
          : 'No liquidity return-delta permissions',
      minimumActions: [
        'Continuous monitoring strongly recommended',
        'Invariant testing required for accounting logic',
        'At least one audit must evaluate liquidity flow correctness',
      ],
    },
    {
      feature: 'External protocol or oracle dependencies',
      triggered: false,
      evidence: 'Not observable from permissions/bytecode metadata — requires source review',
      minimumActions: [
        'Monitoring of dependency health strongly recommended',
        'Audits must review trust assumptions, failure modes, and fallback logic',
        'Scenario testing required for dependency failures',
      ],
    },
    {
      feature: 'Autonomous parameter updates or "self-tuning" hook',
      triggered: dynamic,
      evidence: dynamic
        ? 'Pools with the dynamic-fee flag: the hook sets the LP fee'
        : 'No dynamic-fee pools seen',
      minimumActions: [
        'Invariant testing required for state transitions',
        'Monitoring strongly recommended',
        'Upgradeability must be minimized or time-locked',
      ],
    },
    {
      feature: 'Price impacting behavior',
      triggered: p.beforeSwapReturnDelta || p.afterSwapReturnDelta || dynamic,
      evidence:
        p.beforeSwapReturnDelta || p.afterSwapReturnDelta || dynamic
          ? 'Swap return deltas and/or dynamic fees change the effective swap price'
          : 'No swap return deltas or dynamic fees',
      minimumActions: [
        'Auditor should specialize in math',
        'Bug bounty required',
        'Auditors should simulate worst case economic and adversarial price manipulation scenarios',
      ],
    },
    {
      feature: 'Upgradeable',
      triggered: facts.proxy.upgradeable,
      evidence: facts.proxy.upgradeable
        ? `${facts.proxy.kind} proxy detected`
        : 'No upgradeable proxy pattern detected',
      minimumActions: [
        'Storage collision review required',
        'Documentation of upgrade policy mandatory',
        'Time-lock or multisig control recommended',
      ],
    },
    {
      feature: 'TVL 5 rating (highest liquidity potential)',
      triggered: tvl !== null && tvl >= TVL_5_USD,
      evidence:
        tvl !== null
          ? `Observed TVL $${Math.round(tvl).toLocaleString('en-US')}`
          : 'TVL unknown on this chain',
      minimumActions: [
        'Monitoring mandatory',
        'Bug bounty mandatory',
        'Emergency response procedures required',
      ],
    },
  ];
}

/**
 * [K] "Risk Scoring System" (0–33) restricted to observable categories. The skill gives the
 * Permissions range (0–14) but not per-level points; we weight LOW 0.5, MEDIUM 1, HIGH 1.5,
 * CRITICAL 2 (capped at 14). Upgrade Mechanism (0–5): proxy 3, privileged setters 2.
 * The result is a lower bound: External Calls, State Complexity and Token Handling need source review.
 */
function observableRiskScore(p: HookPermissions, facts: HookFacts) {
  const weight = { LOW: 0.5, MEDIUM: 1, HIGH: 1.5, CRITICAL: 2 } as const;
  const permissions = Math.min(
    14,
    enabledPermissions(p).reduce((sum, e) => sum + weight[e.risk], 0)
  );
  const upgradeMechanism = Math.min(
    5,
    (facts.proxy.upgradeable ? 3 : 0) + (facts.adminSelectors.length > 0 ? 2 : 0)
  );
  const observableTotal = Math.round((permissions + upgradeMechanism) * 10) / 10;
  const tierAtLeast =
    observableTotal >= 21
      ? 'Critical'
      : observableTotal >= 13
      ? 'High'
      : observableTotal >= 6
      ? 'Medium'
      : 'Low';
  return {
    permissions,
    upgradeMechanism,
    observableTotal,
    maxTotal: 33 as const,
    tierAtLeast: tierAtLeast as 'Low' | 'Medium' | 'High' | 'Critical',
    unobserved: ['External Calls (0-5)', 'State Complexity (0-5)', 'Token Handling (0-4)'],
  };
}
