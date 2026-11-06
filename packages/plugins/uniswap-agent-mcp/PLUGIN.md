# PLUGIN.md — `uniswap-agent-mcp` as a `Uniswap/uniswap-ai` plugin

This package is laid out so it can be copied **as-is** into a fork of
[`Uniswap/uniswap-ai`](https://github.com/uniswap/uniswap-ai) at
`packages/plugins/uniswap-agent-mcp/`. It follows that repo's plugin format, the same way the
`uniswap-cca` plugin ships an MCP server: a `.claude-plugin/plugin.json` manifest that points at a
`.mcp.json`, plus `package.json`, `project.json`, `README.md` and `CLAUDE.md`.

## Files and how they map

| File in this package         | Role in `uniswap-ai`                                                                                                            | Mirrors (uniswap-cca)               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `.claude-plugin/plugin.json` | Plugin manifest: `name`, `version`, `description`, `keywords`, `license`, `mcpServers: ["./.mcp.json"]`                         | `.claude-plugin/plugin.json`        |
| `.mcp.json`                  | Claude Code MCP server config: stdio, `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js --transport stdio`, env from the user's shell   | `.mcp.json` (`cca-supply-schedule`) |
| `package.json`               | Package metadata and scripts; version matches `plugin.json` (`0.1.0`, checked by `scripts/validate-plugin.cjs`)                 | `package.json`                      |
| `project.json`               | Nx project with tags `type:plugin`, `scope:uniswap`, `domain:trading`, and targets `build`, `test`, `lint-markdown`, `validate` | `project.json`                      |
| `README.md`                  | Plugin documentation (tool table, sources, setup)                                                                               | `README.md`                         |
| `CLAUDE.md`                  | AI-assistant context for contributors                                                                                           | `CLAUDE.md`                         |
| `src/`, `test/`, `scripts/`  | The MCP server (TypeScript), offline tests and the live smoke test                                                              | `mcp-server/supply-schedule/*`      |

`node docs/vendor/uniswap-ai/scripts/validate-plugin.cjs packages/uniswap-agent-mcp` (the fork's
own validator, run against this package) prints **Validation PASSED**.

## Status in this fork

The copy steps below have been applied in this fork: the plugin lives at
`packages/plugins/uniswap-agent-mcp/`, the tsconfig options are inlined, `gen:api` reads the bundled
`spec/uniswap-trading-openapi.json`, the marketplace entry is added and `docs/plugins/uniswap-agent-mcp.md`
exists. The Warden-only files (Dockerfile, `sync:shared` script) were left out.

## Copy steps (how this was done)

```bash
# in the fork of Uniswap/uniswap-ai
cp -r <warden>/packages/uniswap-agent-mcp packages/plugins/uniswap-agent-mcp
rm -rf packages/plugins/uniswap-agent-mcp/{node_modules,dist,.turbo}
```

1. **Monorepo-only bits.** In Warden, `tsconfig*.json` extend `../../tsconfig.base.json`. In the
   fork, either point `extends` at `../../../tsconfig.base.json`, or inline these options:
   `target ES2023`, `module/moduleResolution NodeNext`, `strict`, `noUncheckedIndexedAccess`,
   `verbatimModuleSyntax`, `resolveJsonModule`, `skipLibCheck`.
2. **Vendored spec path.** `gen:api` reads `../../docs/vendor/uniswap-trading-openapi.json`.
   Change it to the fork's copy of the Trading API spec. The generated
   `src/generated/trading-api.ts` is committed, so the build does not need the spec.
3. **Dependencies.** `bun install` at the fork root picks up `packages/plugins/*` through
   workspaces. All versions are pinned exactly. Keep the root override for
   `@uniswap/sdk-core@7.19.4` / `@uniswap/v3-sdk@3.31.5`, or let the fork's lockfile resolve them.
4. **Marketplace entry.** Add to `.claude-plugin/marketplace.json`:

   ```json
   {
     "name": "uniswap-agent-mcp",
     "source": "./packages/plugins/uniswap-agent-mcp",
     "description": "Agent-ready Uniswap MCP server: quotes, pools, v4 hook scoring, positions and unsigned swap/LP builders"
   }
   ```

5. **Docs page.** Add `docs/plugins/uniswap-agent-mcp.md`, built from `README.md` (tool table,
   sources, setup), and a row in `docs/plugins/index.md`.
6. **Build before use.** The `.mcp.json` runs `dist/index.js`, so run
   `nx run uniswap-agent-mcp:build` (or `npx tsc -p tsconfig.build.json` in the plugin) after
   installing.

## User setup after `/plugin install uniswap-agent-mcp@uniswap-ai`

The plugin reads its configuration from the user's environment, which `.mcp.json` expands:

```bash
export UNISWAP_API_KEY=…            # https://developers.uniswap.org/dashboard
export EXECUTION_RPC_URL=https://…  # testnet the build tools target (default chain 11155111)
export MAINNET_RPC_URL=https://…    # read-only market data
export MCP_RESUME_SECRET=$(openssl rand -hex 32)
export THEGRAPH_API_KEY=…           # optional: subgraph tools
export ETHERSCAN_API_KEY=…          # optional: verified-source checks in score_hook
```

`UNISWAP_DECISION_ORIGIN` is fixed to `human_mediated` in the plugin's `.mcp.json`, because
Claude Code asks the user to confirm tool calls. That follows the swap-integration skill's "Agent
Attribution" rule of choosing the value that matches the integration.

## Relationship to the existing skills

The plugin carries no skills of its own. It packages behaviour that the existing skills describe
as runnable tools:

- `swap-integration`: the request flow, headers, Permit2 field rules and pre-broadcast validation
  in `build_swap`.
- `lp-integration`: the field-name quirks (`batchPermitData` vs `v4BatchPermitData`, `tokenId` vs
  `nftTokenId`), proto permit normalisation and KYC warnings in `build_lp_*`.
- `v4-sdk-integration`: V4Quoter via `eth_call` (`quote_pool`) and `Pool.getPoolId` / `Position`
  math (`get_lp_positions`).
- `v4-security-foundations` and the v4 Security Framework: `score_hook`.

Every tool returns unsigned data only, so the skills' "confirm before executing any transaction"
rule stays with the user's wallet and client.
