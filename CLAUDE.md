# @atlasent/mcp-server

MCP server that enforces `authorize-before-execute` for any MCP-compatible AI agent.

## Architecture

```
src/
  decision.ts         — Decision / VerifyResult types + toolResult() MCP envelope helper
  localEngine.ts      — Tiny rules engine used when no hosted backend is configured
  engine.ts           — authorize() / verify(): dispatches to local or remote; fail-closed wrapper
  server.ts           — createServer(): registers evaluate, verify_permit, deploy_service (demo)
  index.ts            — CLI entry point; connects stdio transport
  server.test.ts      — 26 unit tests: tools/list, evaluate (local + remote), verify_permit, deploy_service
  integration.test.ts — Live-API tests; require ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise

examples/
  demo.mjs            — End-to-end script: spawns server, drives evaluate → deploy → verify flow

.github/workflows/
  ci.yml              — build + test on push/PR, Node 18/20/22 matrix
  integration.yml     — nightly integration tests against the hosted API
  publish.yml         — npm publish --provenance on v* tag push
```

## Interception point

Every protected tool follows the same pattern. See `server.ts`, the `deploy_service` handler:

```ts
const ctx: ActionContext = { action_type: "deploy", actor_id, environment, ... };
const decision = await authorize(ctx);       // ← INTERCEPTION POINT
if (decision.decision !== "allow") {
  return toolResult(decision);                // blocked; nothing executes
}
const result = /* run the action */;
return toolResult(decision, { result });
```

The guarantee: if `authorize()` does not return `allow`, the action code never runs. This is the one invariant the demo proves.

## Mode dispatch

`engine.getMode()` is read on every call (so hosts can flip modes without restart):

- `ATLASENT_MODE=remote` → hosted AtlaSent API
- `ATLASENT_MODE=local` → in-process rules engine
- Unset → `remote` if both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are set, else `local`

The hosted backend is a configuration swap. `authorizeRemote()` / `verifyRemote()` in `engine.ts` are the only adapters; everything above (tool handlers, tests, demo) is unchanged.

## Build, test, run

```bash
npm run build             # tsc → dist/
npm test                  # 26 unit tests, no network
npm run test:integration  # live API; needs ATLASENT_API_KEY + ATLASENT_BASE_URL
npm run demo              # end-to-end demo in local mode
```

Tests use `node:test` + MCP SDK's `InMemoryTransport`. `globalThis.fetch` is mocked per-test in remote-mode tests; local-mode tests touch no network.

## Key design decisions

- **Fail-closed at every layer.** `authorize()` and `verify()` wrap everything in try/catch; any error → `{ decision: "deny" }` or `{ outcome: "error", valid: false }`.
- **Env vars read at call time.** Let tests (and users) swap config without module reload.
- **10s request timeout.** `AbortSignal.timeout()` on every fetch — a hung API must not block the agent.
- **Normalized decision envelope.** One shape for `allow`/`deny`/`hold`, one shape for verification. Remote outputs are coerced into this shape (e.g. `escalate` → `hold`); unknown decisions collapse to `deny`.
- **`isError` set only on failure.** MCP convention — hosts surface tool-call errors in their UI.
- **Stderr structured logs.** Every authorize / execute / verify emits a JSON line to stderr. Doesn't interfere with stdio protocol on stdout.

## API contracts

Hosted backend (atlasent-api Supabase edge functions):

- `POST /v1-evaluate`
  - request: `{ action: { id }, actor: { id }, environment, context }` — `engine.ts.authorizeRemote()` packs `ActionContext.action_type`/`actor_id` into the nested `action.id`/`actor.id` shape the edge function reads, and rides `approvals` / `change_window` inside `context` so they reach the rule engine.
  - response: `{ decision: "allow" | "deny" | "hold" | "escalate", permit?: { id, status, expires_at }, deny_reason?, evaluation_id, … }` — `permit.id` becomes `permit_token` in the MCP envelope; `evaluation_id` becomes `audit_id`. Allow without `permit.id` → fail-closed deny.
- `POST /v1-verify-permit`
  - request: `{ permit_token, action_type, actor_id }` — these field names are read literally by the verify handler (`atlasent-api/supabase/functions/v1-verify-permit/handler.ts`); we don't send the rest of the context.
  - response: `{ valid: boolean, outcome: "allow" | "deny", verify_error_code?, reason? }` — only `outcome === "allow"` with `valid === true` maps to `verified`. Otherwise `verify_error_code` is mapped via the `VERIFY_ERROR_TO_OUTCOME` table in `engine.ts` (`PERMIT_EXPIRED` → `expired`, mismatches/revocations/already-used → `invalid`, auth/rate-limit/internal → `error`); unknown codes fall through to `invalid` (fail-closed).

Headers: `Authorization: Bearer $ATLASENT_API_KEY`, optional `x-anon-key: $ATLASENT_ANON_KEY`. The edge function reads the bearer header for org/key resolution; mcp-server does not echo the key in the body.

When the canonical contract in `atlasent-sdk/contract/schemas/` is reconciled with the deployed edge function, the adapter in `engine.ts` is the only place that needs to move — tool handlers, tests at the MCP layer, and the demo are all decoupled from the wire shape.

## npm publishing

Scoped package `@atlasent/mcp-server`, `publishConfig.access: public`. Published tarball contents limited to `dist/`, `README.md`, `LICENSE` via the `files` field. Tag `v*` triggers `.github/workflows/publish.yml` which runs build, tests, and `npm publish --provenance` using the `NPM_TOKEN` repo secret.
