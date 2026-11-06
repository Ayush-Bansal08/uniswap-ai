# uniswap-agent-mcp

**Agent-ready Uniswap tools over the Model Context Protocol.** 16 typed tools for quotes, pool
comparison, v4 hook safety scoring, LP positions, and swap/LP transaction building. Every tool has
a Zod input and output schema, returns `structuredContent` plus a one-line summary, and is built
only from official Uniswap sources.

> **Unsigned-only by design.** This server never holds a private key, never signs and never
> broadcasts. Build tools return unsigned transactions (`READY`) or EIP-712 typed data to sign
> (`NEEDS_SIGNATURE`). **Why:** the app calling the tools keeps its own safety checks, spending
> limits and human approval, and the agent cannot get around them. A prompt-injected or confused
> model can at most _propose_ a transaction, and it still goes through the caller's checks. A
> test (`test/no-signing.test.ts`) fails if signing or broadcast code ever lands in `src/`.

Works as a backend service (streamable HTTP, bearer auth) and in Claude Code / Cursor (stdio).
Built for the Uniswap track at ETHGlobal Mumbai 2026 as part of Warden (a verified-human AI DeFi agent), and packaged here as a `uniswap-ai` plugin. Install it with `/plugin install uniswap-agent-mcp@uniswap-ai` after adding this marketplace; see [PLUGIN.md](PLUGIN.md).

---

## Tools

| #   | Tool                | Type  | Inputs (key)                                                                                                         | Outputs (key)                                                                                                                 | Uniswap source                                                                                           |
| --- | ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `get_quote`         | read  | chainId, tokenIn/out (symbol or address), amount (human), type, swapper, slippagePct?                                | amountIn/out (raw + decimal), minOut / maxIn, priceImpactPct, gas (wei + USD), route (pools, fees, hooks), quoteId, expiresAt | Trading API `POST /quote` (CLASSIC) · `swap-integration` skill                                           |
| 2   | `quote_pool`        | read  | chainId, poolKey, zeroForOne, exactAmount, type                                                                      | amountIn/out, gasEstimate, poolId                                                                                             | v4 **V4Quoter** `quoteExactInputSingle` / `quoteExactOutputSingle` via `eth_call` · `v4-sdk-integration` |
| 3   | `get_portfolio`     | read  | chainId, address, tokens?                                                                                            | per token: balanceRaw, balance, priceUsd, valueUsd; totalUsd                                                                  | multicall `balanceOf` + mainnet `/quote` reference prices                                                |
| 4   | `get_price_history` | read  | symbol, window `1h/24h/7d`, interval `hour/day`                                                                      | series `[{ts, priceUsd}]`, open/close/high/low, changePct, **asOf + lag + stale**                                             | official **v4 subgraph** (`PoolHourData`/`PoolDayData`, `TokenHourData`/`TokenDayData`)                  |
| 5   | `get_lp_positions`  | read  | chainId, owner, tokenIds[]                                                                                           | pool key, hook, ticks, currentTick, inRange, amounts, uncollected fees, valueUsd                                              | v4 **PositionManager** + **StateView**; `@uniswap/v4-sdk` `Position` math                                |
| 6   | `compare_pools`     | read  | chainId, tokenA, tokenB                                                                                              | execution pools + mainnet market pools (TVL, 7d volume/fees, fee APR), ranked list, `recommended` + reasons                   | LP API `POST /lp/pool_info` + StateView; v4 subgraph                                                     |
| 7   | `check_token`       | read  | chainId, token                                                                                                       | allowlist, unsupported-list, isContract, liquidityDepthUsd ($1k probe), riskFlags, verdict OK/CAUTION/BLOCK                   | Uniswap unsupported-token list (supported-chains doc) + `/quote` price impact                            |
| 8   | `list_new_hooks`    | read  | scope `market/execution`, sinceDays?, pair?, limit?                                                                  | hooks with pools, TVL (market), firstSeen                                                                                     | v4 subgraph (market) · PoolManager `Initialize` logs, 5k-block windows (execution)                       |
| 9   | `score_hook`        | read  | chainId, hookAddress                                                                                                 | score 0–100, band SAFE/CAUTION/DANGER, permissions, facts, per-rule breakdown with evidence + source, framework triggers      | **v4 Security Framework** + `v4-security-foundations` skill; `Hooks.sol` permission bits                 |
| 10  | `get_hook_state`    | read  | chainId, hookAddress, poolIds?                                                                                       | codeHash, implementation (+ hash), owner, per-pool lpFee/protocolFee/sqrtPrice/tick/liquidity, takenAt                        | StateView `getSlot0`/`getLiquidity`; EIP-1967 slots                                                      |
| 11  | `build_swap`        | build | chainId, swapper, tokenIn/out, amount, type, slippagePct, recipient?, resumeToken?, signature?                       | `READY` (approvals → swap) or `NEEDS_SIGNATURE` (approval preSteps, Permit2 typed data, resumeToken)                          | Trading API `/check_approval` → `/quote` → `/swap` · `swap-integration` skill                            |
| 12  | `build_transfer`    | build | chainId, from, token, amount, to                                                                                     | `READY` (native value transfer or ERC-20 `transfer` calldata)                                                                 | viem `encodeFunctionData`                                                                                |
| 13  | `build_lp_position` | build | chainId, owner, pool {poolReference, token0, token1}, independentToken, range, slippagePct, resumeToken?, signature? | `READY` (approvals → LP_CREATE, adjusted prices) or `NEEDS_SIGNATURE` (v4 batch permit)                                       | LP API `/lp/check_approval` → `/lp/create` · `lp-integration` skill                                      |
| 14  | `build_lp_exit`     | build | chainId, owner, token0/1, tokenId, percent 1–100, claimFees                                                          | `READY` (LP_CLAIM? → LP_DECREASE) with expected amounts                                                                       | LP API `/lp/claim_fees`, `/lp/decrease`                                                                  |
| 15  | `build_rebalance`   | build | chainId, owner, tokenId, token0/1, poolReference, newRange                                                           | `READY` exit steps + `next: { tool: 'build_lp_position', args }` from expected amounts                                        | LP API `/lp/decrease` + StateView fees + v4-sdk                                                          |
| 16  | `plan_trigger`      | plan  | kind TAKE_PROFIT/STOP_LOSS/DCA/CHAINED/PRICE_ALERT, condition, actions[]                                             | canonical `TriggerSpec` + `humanSummary` ("Sell 50% of your ETH for USDC when ETH ≥ $3,312.40 (+2%)")                         | pure validation; reference price from mainnet `/quote` for `price_change_pct`                            |

Tool errors are MCP tool errors (`isError: true`) whose text is
`{"error":{"code":"NO_ROUTE","message":"…","retryable":false}}`. The codes are listed in
`TOOL_ERROR_CODES` in [`src/schemas.ts`](src/schemas.ts).

### The NEEDS_SIGNATURE → finalize flow

```text
caller                                   uniswap-agent-mcp                         Uniswap
  │ build_swap(args)                         │ /check_approval, /quote ────────────────▶│
  │◀── NEEDS_SIGNATURE ──────────────────────│  permitData present                      │
  │    preSteps: [APPROVAL tx]               │  resumeToken = HMAC(quote, permitData,   │
  │    signature.typedData (EIP-712)         │                 argsHash, exp=120 s)     │
  │ run preSteps, sign typedData (caller's   │                                          │
  │ own wallet + safety + approval)          │                                          │
  │ build_swap(args, resumeToken, signature)▶│ verify HMAC, tool, args, expiry          │
  │                                          │ /swap {quote, permitData, signature} ───▶│
  │◀── READY: [SWAP tx] ─────────────────────│ validate tx (to/from/chainId/data)       │
```

The `resumeToken` holds only public data (the quote and permit). It is integrity-protected with
HMAC-SHA256 (`MCP_RESUME_SECRET`), tied to the tool and to a hash of the original arguments, and
expires after 120 s. A tampered, replayed or stale token is rejected.

---

## Built from official Uniswap sources

| Source                                           | Used for                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Uniswap API OpenAPI spec** (Trading API)       | Typed client generated with `openapi-typescript` (`pnpm gen:api` → [`src/generated/trading-api.ts`](src/generated/trading-api.ts)); `/check_approval`, `/quote`, `/swap`                                                                 |
| **Uniswap LP API** (`liquidity.api.uniswap.org`) | `/lp/check_approval`, `/lp/create`, `/lp/decrease`, `/lp/claim_fees`, `/lp/pool_info` (types from the same OpenAPI contract, plus `kycRequiredWarnings` from the skill)                                                                  |
| **v4 contracts**                                 | V4Quoter, StateView, PoolManager (`Initialize` events), PositionManager. Addresses come only from the v4 deployments doc ([`src/chains.ts`](src/chains.ts))                                                                              |
| **Official v4 subgraph**                         | Pools, TVL, PoolDayData fees/volume, price history (entities from the vendored schema)                                                                                                                                                   |
| **`Uniswap/uniswap-ai` skills**                  | `swap-integration` (flow, headers, Permit2 rules, validation), `lp-integration` (field quirks, permit normalisation), `v4-sdk-integration` (Quoter via `eth_call`, `Pool.getPoolId`), `v4-security-foundations` (permission risk matrix) |
| **v4 Security Framework** (Uniswap Foundation)   | Hook scoring rules, feature triggers (§4) and their minimum actions                                                                                                                                                                      |

Headers follow the swap-integration skill: `x-api-key`, `x-universal-router-version: 2.1.2`, and
`x-agent-info` with `integration_name`/`decision_origin`/`version`. We use 2.1.2 because the
supported-chains doc says 2.0 support ended on 2026-10-21, even though the skill's example still
sends 2.0.

---

## Hook safety score (`score_hook`)

The permission flags come from the low 14 bits of the hook address, using the `Hooks.sol` order
(`beforeInitialize` = bit 13 … `afterRemoveLiquidityReturnDelta` = bit 0). The facts are read
on-chain. **Score = 100 − penalties**. The bands are SAFE ≥ 80, CAUTION ≥ 50, and DANGER below
that or when the address has no code.

| Rule                                                    | Penalty              | Source section                                                                |
| ------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| no code at the hook address                             | −100                 | skill Threat Model                                                            |
| return-delta permissions                                | −25 each, capped −40 | Framework §1 "BeforeSwapDelta and NoOp override risks"; skill "NoOp Rug Pull" |
| HIGH-risk callbacks (beforeSwap, beforeRemoveLiquidity) | −5 each, capped −10  | skill "Permission Flags Risk Matrix"                                          |
| upgradeable proxy (EIP-1967/1822/beacon)                | −20                  | Framework §1 "Upgradeability hazards", §4 "Upgradeable"                       |
| privileged owner + setter selectors in bytecode         | −15                  | Framework §1 "Autonomous behavior or parameter updates", §7 "Core controls"   |
| source not verified (or unknown)                        | −15                  | Framework §7 "Transparency requirements" (scored conservatively, §2)          |
| first seen < 7 days ago                                 | −10                  | Framework §1 "TVL growth over time", §2 "Team maturity"                       |
| dynamic-fee pool                                        | −5                   | Framework §1 "Price impacting behavior and dynamic fees"                      |

The framework itself is a developer self-assessment (nine dimensions summing to 0–33, plus
feature triggers). It does not define a 0–100 score, so the output also includes the framework's
own outputs: every §4 feature trigger with its minimum required actions, and the skill's 0–33 risk
score limited to what can be observed on-chain (`tierAtLeast`). See
[`src/hooks/score.ts`](src/hooks/score.ts).

---

## Run with Claude Code (stdio)

```bash
npx tsc -p tsconfig.build.json            # from packages/plugins/uniswap-agent-mcp
claude mcp add uniswap-agent \
  -e UNISWAP_API_KEY=… -e EXECUTION_CHAIN_ID=11155111 \
  -e EXECUTION_RPC_URL=https://… -e MAINNET_RPC_URL=https://… \
  -e THEGRAPH_API_KEY=… -e MCP_RESUME_SECRET=$(openssl rand -hex 32) \
  -e UNISWAP_DECISION_ORIGIN=human_mediated \
  -- node /absolute/path/to/packages/uniswap-agent-mcp/dist/index.js --transport stdio
```

Or add this to `.mcp.json` (Claude Code) or `~/.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "uniswap-agent": {
      "command": "node",
      "args": [
        "/absolute/path/to/packages/uniswap-agent-mcp/dist/index.js",
        "--transport",
        "stdio"
      ],
      "env": {
        "UNISWAP_API_KEY": "…",
        "EXECUTION_CHAIN_ID": "11155111",
        "EXECUTION_RPC_URL": "https://…",
        "MAINNET_RPC_URL": "https://…",
        "THEGRAPH_API_KEY": "…",
        "MCP_RESUME_SECRET": "64-hex-chars…",
        "UNISWAP_DECISION_ORIGIN": "human_mediated"
      }
    }
  }
}
```

Then ask, for example: _"Quote 0.01 ETH to USDC on Sepolia"_, _"Score hook 0x…c0 on mainnet"_ or
_"Which ETH/USDC pool should I LP in?"_. In stdio mode, logs go to stderr and stdout carries only
the protocol.

## Run over HTTP (backends)

```bash
npm run dev                               # http://localhost:3002/mcp (reads the nearest .env)
# or: node dist/index.js --transport http --port 3002

curl -s http://localhost:3002/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- `POST /mcp` uses stateless streamable HTTP, with JSON responses and a fresh server per request.
- It requires `Authorization: Bearer <MCP_AUTH_TOKEN>`, compared in constant time; otherwise it
  returns 401.
- Requests are rate-limited per token (`MCP_RATE_LIMIT_PER_MIN`, default 600), returning 429 with
  `retry-after`.
- `GET /health` needs no auth.

## Configuration

| Variable                                     | Required             | Notes                                                                     |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `UNISWAP_API_KEY`                            | yes                  | Uniswap Developer Platform key (Trading + LP API)                         |
| `EXECUTION_CHAIN_ID`                         | default `11155111`   | Build tools only target this chain; mainnet (1) is read-only              |
| `EXECUTION_RPC_URL`, `MAINNET_RPC_URL`       | yes                  | Archive-capable RPC recommended (PoolManager start-block search)          |
| `MCP_RESUME_SECRET`                          | yes                  | ≥ 32 chars; HMAC key for resumeTokens                                     |
| `MCP_AUTH_TOKEN`                             | HTTP only            | ≥ 24 chars                                                                |
| `THEGRAPH_API_KEY`, `UNISWAP_V4_SUBGRAPH_ID` | market data          | Without a key, subgraph tools return `NOT_CONFIGURED`                     |
| `ETHERSCAN_API_KEY`                          | optional             | Verified source and contract age (Etherscan v2 multichain)                |
| `UNISWAP_DECISION_ORIGIN`                    | default `autonomous` | `x-agent-info` attribution; use `human_mediated` in Claude Code           |
| `UNISWAP_UNIVERSAL_ROUTER_VERSION`           | default `2.1.2`      | Also used to check the swap `to` address against `chains.ts`              |
| `TOKEN_ALLOWLIST_JSON`                       | optional             | Extra tokens `[{chainId,address,symbol,decimals,referenceSymbol?}]`       |
| `MCP_PORT` / `PORT`, `MCP_HOST`              | optional             | `--port` flag wins, then MCP_PORT, then PORT (Railway), then 3002         |
| `HTTP_TIMEOUT_MS`, `LOGS_BLOCK_WINDOW`       | optional             | 10 000 ms; 5 000 blocks (halved automatically if the RPC rejects a range) |

## Correctness and safety

- **Every transaction is validated** ([`src/tx.ts`](src/tx.ts)):
  - `data` must be non-empty hex. The only exception is a native ETH transfer.
  - `to` and `from` are returned checksummed.
  - `chainId` must equal the requested chain, and `from` must equal the requested swapper or owner.
  - `to` must be the contract expected for that step: the Universal Router for this version, the
    PositionManager, the token, or Permit2.
- **Calldata from Uniswap is never modified.**
- **Symbols resolve only against the allowlist** (ETH, WETH, USDC and `TOKEN_ALLOWLIST_JSON`), so
  a look-alike "USDC" can never be picked up by symbol. Any other token must be passed by address
  and is flagged.
- **Amounts never round silently.** An input with more decimals than the token supports is
  rejected. All amounts are strings: `raw` in base units, `decimal` in human units.
- **USD values come from mainnet reference quotes**, because testnet pool prices are 10–15× off.
- **Resilience:** 10 s timeout per attempt, and up to 3 retries with exponential backoff and
  jitter on 429, 5xx and network errors.
- **In-memory LRU cache** with these TTLs: quotes 15 s, reference prices 30 s, pool stats and
  hooks 5 min, token metadata and the unsupported-token list 24 h. Identical concurrent reads
  share one in-flight request.
- **Subgraph lag is reported, not hidden.** Outputs carry `asOf`, `lagSeconds`, `stale` and
  `hasIndexingErrors`.

## Where to look (for judges)

| File                                                               | What it shows                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [`src/tools/build_swap.ts`](src/tools/build_swap.ts)               | Trading API flow: `/check_approval` → `/quote` → Permit2 `NEEDS_SIGNATURE` → `/swap` |
| [`src/tools/build_lp_position.ts`](src/tools/build_lp_position.ts) | LP API flow: `/lp/check_approval` → v4 batch permit → `/lp/create` with tickBounds   |
| [`src/hooks/score.ts`](src/hooks/score.ts)                         | Security Framework scoring, with each rule citing its section                        |
| [`src/tools/quote_pool.ts`](src/tools/quote_pool.ts)               | V4Quoter "what-if" quote via `eth_call`                                              |
| [`src/hooks/permissions.ts`](src/hooks/permissions.ts)             | Hook permission bits → flags + risk matrix                                           |
| [`src/chains.ts`](src/chains.ts)                                   | Every address, with its vendor-doc source                                            |
| [`src/schemas.ts`](src/schemas.ts)                                 | All 16 input/output schemas + TxStep / SignatureRequest / BuildResult                |
| [`test/`](test/)                                                   | 134 offline tests (fake fetch + fake RPC), including MCP over real HTTP              |

## Development

```bash
# from the repo root (Nx)
bunx nx run uniswap-agent-mcp:build       # tsc → dist/
bunx nx run uniswap-agent-mcp:test        # vitest, no network
# or from packages/plugins/uniswap-agent-mcp
npm run gen:api                           # regenerate Trading API types from spec/
npm run smoke                             # LIVE smoke against real APIs (read-only + one unsigned build)
```

## Known limitations

- Only CLASSIC (AMM) routing is supported. UniswapX quotes are refused (`UNSUPPORTED_ROUTING`)
  because every swap must be a single unsigned transaction the caller can check.
- `build_lp_position` only adds to existing v4 pools. Creating a new pool (`newPool`) is not
  supported on purpose.
- Sepolia WETH does not appear in any vendored doc, so it is left unset. Add it through
  `TOKEN_ALLOWLIST_JSON` if you need v3 pools.
- On the execution chain, hook age and pool discovery scan only the last 30 days of `Initialize`
  logs, unless Etherscan is configured.
- `check_token` liquidity depth is an estimate for a constant-product pool from the price impact
  of a $1k quote (`depth ≈ 1000 / impact`).

## License

MIT
