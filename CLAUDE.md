# @atlasent/mcp-server

MCP server that enforces `authorize-before-execute` for any MCP-compatible AI agent.

## Architecture

```
src/
  decision.ts         — ActionContext / Decision / VerifyResult types + toolResult / toolError MCP envelopes
  localEngine.ts      — Tiny rules engine used when no hosted backend is configured
  engine.ts           — authorize() / verify(): dispatches to local or remote; fail-closed wrapper
  server.ts           — createServer(): registers evaluate, verify_permit, and the four gated demo tools
  index.ts            — CLI entry point; connects createServer() to stdio (or HTTP) transport
  resources.ts        — MCP resource template for atlasent://policies/{id}
  http-transport.ts   — Optional HTTP transport, enabled by ATLASENT_TRANSPORT=http
  server.test.ts      — Unit tests: tools/list, envelope banners, evaluate (local + remote), verify_permit,
                        send_email, access_sensitive_dataset, write_to_production, deploy_service
  integration.test.ts — Live-API tests; require ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise

examples/
  demo.mjs            — End-to-end script: walks through block + allow for each gated demo tool

.github/workflows/
  ci.yml              — build + test on push/PR, Node 18/20/22 matrix
  integration.yml     — nightly integration tests against the hosted API
  publish.yml         — npm publish --provenance on v* tag push
```

## Tool set

Primitives (for self-gating agents):
- `evaluate` — returns a Decision
- `verify_permit` — closes the audit loop

Gated demo tools (each runs `authorize()` before executing):
- `send_email` — blocks external recipients without an approval
- `access_sensitive_dataset` — blocks PII / PHI reads without an approval
- `write_to_production` — blocks prod writes without an approval
- `deploy_service` — original demo tool; blocks prod deploys without an approval

## Interception point

Every protected tool follows the same pattern. See any of the gated handlers in `server.ts`:

```ts
const ctx: ActionContext = {
  action_type, actor_id, environment, approvals,
  context: { /* tool-specific attributes the policy may inspect */ },
};
const decision = await authorize(ctx);       // ← INTERCEPTION POINT
if (decision.decision !== "allow") {
  return toolResult(decision);                // blocked; nothing executes
}
const result = /* run the action */;
return toolResult(decision, { result });
```

The guarantee: if `authorize()` does not return `allow`, the action code never runs. This is the one invariant the demo proves. A separate `toolError()` envelope is used when the action was authorized but crashed mid-execution, so blocked-by-authorization stays distinguishable from tool-ran-and-failed.

## Mode dispatch

`engine.getMode()` is read on every call (so hosts can flip modes without restart):

- `ATLASENT_MODE=remote` → hosted AtlaSent API
- `ATLASENT_MODE=local` → in-process rules engine
- Unset → `remote` if both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are set, else `local`

The hosted backend is a configuration swap. `authorizeRemote()` / `verifyRemote()` in `engine.ts` are the only adapters; everything above (tool handlers, tests, demo) is unchanged.

## Build, test, run

```bash
npm run build             # tsc → dist/
npm test                  # unit tests, no network
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

Hosted backend:

- `POST /v1-evaluate` → `{ decision, permit_token?, reason?, audit_id?, conditions?, hold_id? }`
- `POST /v1-verify-permit` → `{ outcome, valid, reason?, audit_id? }`

Headers: `Authorization: Bearer $ATLASENT_API_KEY`, optional `x-anon-key: $ATLASENT_ANON_KEY`.

## npm publishing

Scoped package `@atlasent/mcp-server`, `publishConfig.access: public`. Published tarball contents limited to `dist/`, `README.md`, `LICENSE` via the `files` field. Tag `v*` triggers `.github/workflows/publish.yml` which runs build, tests, and `npm publish --provenance` using the `NPM_TOKEN` repo secret.
