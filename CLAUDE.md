# @atlasent/mcp-server

MCP server that enforces `authorize-before-execute` for any MCP-compatible AI agent.

## Architecture baseline

> Canonical cross-repo reference: [`atlasent-docs/architecture/ARCHITECTURE-BASELINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/architecture/ARCHITECTURE-BASELINE.md)

This repo's role: **MCP distribution layer** — exposes AtlaSent authorization as MCP tools (`atlasent_evaluate`, `atlasent_verify_permit`) for any MCP-compatible agent host (Claude Desktop, Cursor, Windsurf) without requiring a custom SDK integration.

Cross-repo invariants for this repo:
- Wire shape source of truth: `atlasent-api/supabase/functions/v1-{evaluate,verify-permit}/handler.ts`. Do not invent new request/response shapes here.
- Fail-closed at every layer: any error in `authorize()` or `verify()` collapses to deny. This is non-negotiable.
- 10-second request timeout on every hosted-API fetch (`AbortSignal.timeout()`). A hung API must not block the agent.
- Mode dispatch reads env vars at call time (not module load), so tests can swap config without reload.

---

## Architecture

```
src/
  decision.ts         Decision / VerifyResult types + toolResult() MCP envelope helper
  localEngine.ts      Tiny rules engine used when no hosted backend is configured
  engine.ts           authorize() / verify(): dispatches to local or remote; fail-closed wrapper
  server.ts           createServer(): registers evaluate, verify_permit, deploy_service (demo)
  index.ts            CLI entry point; connects stdio transport
  server.test.ts      26 unit tests: tools/list, evaluate (local + remote), verify_permit, deploy_service
  integration.test.ts Live-API tests; require ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise

examples/
  demo.mjs            End-to-end script: spawns server, drives evaluate -> deploy -> verify flow

.github/workflows/
  ci.yml              build + test on push/PR, Node 18/20/22 matrix
  integration.yml     nightly integration tests against the hosted API
  publish.yml         npm publish --provenance on v* tag push
```

## Interception point

Every protected tool follows the same pattern. See `server.ts`, the `deploy_service` handler:

```ts
const ctx: ActionContext = { action_type: "deploy", actor_id, environment, ... };
const decision = await authorize(ctx);       // INTERCEPTION POINT
if (decision.decision !== "allow") {
  return toolResult(decision);                // blocked; nothing executes
}
const result = /* run the action */;
return toolResult(decision, { result });
```

The guarantee: if `authorize()` does not return `allow`, the action code never runs.

## Mode dispatch

`engine.getMode()` is read on every call (so hosts can flip modes without restart):

- `ATLASENT_MODE=remote` -> hosted AtlaSent API
- `ATLASENT_MODE=local` -> in-process rules engine
- Unset -> `remote` if both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are set, else `local`

## Build, test, run

```bash
npm run build             # tsc -> dist/
npm test                  # 26 unit tests, no network
npm run test:integration  # live API; needs ATLASENT_API_KEY + ATLASENT_BASE_URL
npm run demo              # end-to-end demo in local mode
```

Tests use `node:test` + MCP SDK's `InMemoryTransport`. `globalThis.fetch` is mocked per-test in remote-mode tests; local-mode tests touch no network.

## Key design decisions

- **Fail-closed at every layer.** `authorize()` and `verify()` wrap everything in try/catch; any error -> `{ decision: "deny" }` or `{ outcome: "error", valid: false }`.
- **Env vars read at call time.** Let tests (and users) swap config without module reload.
- **10s request timeout.** `AbortSignal.timeout()` on every fetch.
- **Normalized decision envelope.** One shape for `allow`/`deny`/`hold`; remote outputs coerced into this shape (`escalate` -> `hold`); unknown decisions collapse to `deny`.
- **`isError` set only on failure.** MCP convention.
- **Stderr structured logs.** Every authorize / execute / verify emits a JSON line to stderr.

## API contracts

Hosted backend: `atlasent-api/supabase/functions/v1-{evaluate,verify-permit}/handler.ts` is the source of truth.

- `POST /v1-evaluate`: `{ action_type, actor_id, context }` -> `{ decision, permit_token?, request_id, expires_at?, denial? }`
- `POST /v1-verify-permit`: `{ permit_token, action_type, actor_id }` -> `{ valid, outcome, verify_error_code?, reason? }`

Headers: `Authorization: Bearer $ATLASENT_API_KEY`, optional `x-anon-key: $ATLASENT_ANON_KEY`.

## npm publishing

Scoped package `@atlasent/mcp-server`, `publishConfig.access: public`. Tag `v*` triggers `publish.yml` which runs build, tests, and `npm publish --provenance` using the `NPM_TOKEN` repo secret.
