---
title: Uniswap Agent MCP
order: 10
---

# Uniswap Agent MCP

An MCP server that gives AI agents typed Uniswap tools: quotes, pool comparison, v4 hook safety
scoring, LP positions, and builders for swap and LP transactions. Build tools return **unsigned**
transactions only. The server never holds a key, never signs and never broadcasts, so the calling
app keeps its own checks and the user's approval.

## Installation

```bash
/plugin install uniswap-agent-mcp
```

Build the server once after installing (`npx tsc -p tsconfig.build.json` in the plugin folder),
then set these variables in your shell: `UNISWAP_API_KEY`, `EXECUTION_RPC_URL`, `MAINNET_RPC_URL`
and `MCP_RESUME_SECRET`. `THEGRAPH_API_KEY` and `ETHERSCAN_API_KEY` are optional.

## MCP Servers

| Server        | Description                                                                | Type  |
| ------------- | -------------------------------------------------------------------------- | ----- |
| uniswap-agent | 16 Uniswap tools: read, build (unsigned transactions) and trigger planning | stdio |

The same server also runs over streamable HTTP (`--transport http`, bearer token) for backends.

## Tools

| Tool                | Type  | Uniswap source                                        |
| ------------------- | ----- | ----------------------------------------------------- |
| `get_quote`         | read  | Trading API `/quote` (CLASSIC routing)                |
| `quote_pool`        | read  | v4 Quoter, simulated with `eth_call`                  |
| `get_portfolio`     | read  | Token balances plus mainnet reference prices          |
| `get_price_history` | read  | v4 subgraph hour and day data                         |
| `get_lp_positions`  | read  | v4 PositionManager and StateView, v4 SDK math         |
| `compare_pools`     | read  | LP API `/lp/pool_info`, StateView and the v4 subgraph |
| `check_token`       | read  | Unsupported token list and `/quote` price impact      |
| `list_new_hooks`    | read  | v4 subgraph and PoolManager `Initialize` events       |
| `score_hook`        | read  | v4 Security Framework and `v4-security-foundations`   |
| `get_hook_state`    | read  | StateView and proxy storage slots                     |
| `build_swap`        | build | Trading API `/check_approval`, `/quote`, `/swap`      |
| `build_transfer`    | build | ERC-20 `transfer` calldata                            |
| `build_lp_position` | build | LP API `/lp/check_approval`, `/lp/create`             |
| `build_lp_exit`     | build | LP API `/lp/claim_fees`, `/lp/decrease`               |
| `build_rebalance`   | build | LP API `/lp/decrease` plus a planned re-entry         |
| `plan_trigger`      | plan  | Validates take-profit, stop-loss and DCA plans        |

## Signature Flow

When a swap or an LP position needs a Permit2 signature, the build tool returns `NEEDS_SIGNATURE`.
The result holds the approval transactions to run first, the EIP-712 data to sign and a
`resumeToken`. The token is protected with an HMAC and expires after 120 seconds. Call the same
tool again with the same arguments, the `resumeToken` and the `signature` to get the final
unsigned transaction.

## Related Skills

- [swap-integration](../skills/swap-integration): the Trading API flow that `build_swap` follows
- [lp-integration](../skills/lp-integration): the LP API flow that `build_lp_position` follows
- [v4-sdk-integration](../skills/v4-sdk-integration): Quoter and position math
- [v4-security-foundations](../skills/v4-security-foundations): the risk matrix behind `score_hook`

See the plugin [README](https://github.com/Ayush-Bansal08/uniswap-ai/tree/feat/uniswap-agent-mcp/packages/plugins/uniswap-agent-mcp)
for configuration, the scoring rules and file pointers.
