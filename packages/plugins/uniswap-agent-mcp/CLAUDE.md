# CLAUDE.md — uniswap-agent-mcp

MCP server (TypeScript, Node 22) exposing 16 Uniswap tools. **It never holds keys, signs or
broadcasts**: build tools return unsigned transactions (`READY`) or EIP-712 typed data to sign
(`NEEDS_SIGNATURE` + HMAC `resumeToken`, 120 s).

- Tools: `src/tools/<name>.ts` (one file each; schemas in `src/schemas.ts`, zod only).
- Addresses: `src/chains.ts` only, copied from the vendored Uniswap docs. Never add a remembered address.
- Hook score: `src/hooks/score.ts` (rules cite Security Framework / v4-security-foundations sections).
- Uniswap API types are generated: `pnpm gen:api` → `src/generated/trading-api.ts` (do not edit).
- Tests are offline (fake fetch + fake ChainReader in `test/helpers.ts`): `npx vitest run`.
- `test/no-signing.test.ts` fails the build if signing/broadcast code appears in `src/` or `scripts/`.
- `pnpm gen:api` / `npm run gen:api` regenerates types from `spec/uniswap-trading-openapi.json` (the Trading API spec).
