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
  decision.ts                   Decision / VerifyResult types + toolResult() MCP envelope helper
  localEngine.ts                Tiny rules engine used when no hosted backend is configured
  engine.ts                     authorize() / verify(): dispatches to local or remote; fail-closed wrapper
  server.ts                     createServer(): registers evaluate, verify_permit, deploy_service + 20+ tools
  canonCatalog.ts               GENERATED-DERIVED: the canonical action specs incl. canon_id (from the atlasent repo); backs atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  canonGraph.ts                 GENERATED-DERIVED: per-action knowledge-graph neighborhood + compliance (from atlasent/generated/authorization-graph.json); enriches atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  atlasCatalog.ts               GENERATED-DERIVED: the Knowledge Atlas (concepts + edges, from atlasent-docs/architecture/traceability/atlas.json); backs atlasent_atlas_lookup. Re-vendor with scripts/vendor-atlas.mjs
  v2Tools.ts                    Wave B tools: atlasent_evaluate_many, atlasent_evaluate_stream, atlasent_query
  v2Client.ts                   HTTP clients for Wave A endpoints; FeatureNotEnabledError on 404
  complianceTools.ts            SCIM, SIEM config, evidence export MCP tools
  vqpTools.ts                   VQP snapshot generation, verification, drift event tools
  trajectoryVerify.ts           atlasent_trajectory_verify: per-step trajectory drift detection
  streamableHttp.ts             Streamable HTTP transport (MCP HTTP mode)
  index.ts                      CLI entry point; connects stdio transport
  server.test.ts                Unit tests: tools/list, evaluate (local + remote), verify_permit, deploy_service
  server.readonly.test.ts       READONLY mode tests
  complianceTools.test.ts       Compliance tool unit tests
  v2Tools.test.ts               V2 Wave B tool unit tests
  v2Client.test.ts              V2 HTTP client unit tests
  trajectoryVerify.test.ts      Trajectory verify unit tests
  streamableHttp.integration.test.ts  Streamable HTTP transport integration tests
  integration.test.ts           Live-API tests; require ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise
  integration.write.test.ts     Live-API write tests (mutating tools)

examples/
  demo.mjs            End-to-end script: spawns server, drives evaluate -> deploy -> verify flow

.github/workflows/
  ci.yml              build + test on push/PR, Node 18/20/22 matrix
  integration.yml     nightly integration tests against the hosted API
  publish.yml         npm publish --access public (cosign-signed tarball) on v* tag push, gated by an AtlaSent release check
```

## Interception point

Every protected tool follows the same pattern. See `server.ts`, the `deploy_service` handler:

```ts
const ctx: ActionContext = { action_type: "production.deploy", actor_id, environment, ... };
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
npm test                  # 158 unit tests, no network (count grows as tools are added)
npm run test:integration  # live API; needs ATLASENT_API_KEY + ATLASENT_BASE_URL
npm run demo              # end-to-end demo in local mode
```

Tests use `node:test` + MCP SDK's `InMemoryTransport`. `globalThis.fetch` is mocked per-test in remote-mode tests; local-mode tests touch no network. The `npm test` count grows as new tools are added; check `src/*.test.ts` for the current count.

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

## Disabled Endpoints (atlasent-api)

The following atlasent-api edge functions are intentionally **not deployed** on the runtime project and have **no corresponding MCP tools** in this repo. Do not add MCP tools that call these paths — they will always 404 in production. **Updated 2026-08-28** — the disabled set has grown past the original 3 SSO skeleton handlers (disabled 2026-06-02); it is now 8 entries. None of the 5 added since have an MCP tool referencing them either (verified against `src/` — no `policy-rules`/`policy-simulate-layered`/`control-assurance`/`outcome-proposals` references):

| Function name | Notes |
|---|---|
| `v1-sso-assertion-hook` | SSO SAML assertion hook — held back until SSO is in the V1 pilot surface |
| `v1-sso-providers` | SSO identity-provider management — held back. Its notes previously said "re-enable with `v1-sso-connections`" — that cross-reference is stale as of 2026-08-10 since `v1-sso-connections` is now quarantined, not a re-enable target |
| `v1-sso-connections` | **QUARANTINED 2026-08-10** (SSO Configuration Authority remediation) — not merely held back for scope. Had a real table-mismatch bug: POST/GET wrote/read `sso_connections` while GET /:id, PATCH, DELETE operated on `identity_providers`. `v1-sso` (shipped, live) already implements this resource correctly. Do not re-enable without a redesign |
| `v1-policy-rules` | **QUARANTINED 2026-08-18** — plane-mismatch bug, not a scope gap: every route reads/writes `public.policy_rules`, which is confirmed absent on runtime production (that table lives only in `atlasent-console`'s migrations). Do not re-enable by just adding the table; needs a plane-ownership redesign first |
| `v1-policy-simulate-layered` | **QUARANTINED 2026-08-24** (#2181 follow-up) — same absent-on-runtime `policy_rules` dependency as `v1-policy-rules` above, via its `bundle_id`-driven path. Same redesign prerequisite |
| `v1-control-assurance` | **HELD BACK 2026-08-21** (CROSS-022) — fully implemented and tested, but kept out of `runtime-functions.json` because this repo's deploy model has no partial-rollout track and its `classification.json` production_eligibility is still experimental/disabled |
| `v1-internal-control-assurance-write` | **HELD BACK 2026-08-21** (CROSS-022 step 4) — internal-worker-secret auth only; held back because no worker that calls it has been built yet, same manifest-has-no-partial-rollout reason as above |
| `v1-outcome-proposals` | **HELD BACK 2026-08-27** (CROSS-042) — disabled-by-default AI Proposed Trajectories slice; production enablement requires first-party Anthropic/US-inference/ZDR attestation and security review not yet done |

> **Re-enabled 2026-06-01 — do NOT re-add to the table:** `v1-redteam-runs`,
> `v1-post-evaluations`, `v1-spiffe-validate`, `v1-policy-bundles`, `v1-marketplace-packs`,
> `v1-decisions-stream`, `v1-transparency-anchor` are all deployed today and present in
> `runtime-functions.json`. **`v1-sso` is shipped, not disabled** — it is distinct from the
> three `v1-sso-*` skeletons above; do not conflate them.

Source of truth: `atlasent-api/supabase/runtime-functions-disabled.json`. The V2 Wave A batch/stream/graphql endpoints (`/v1/evaluate/batch`, `/v1/evaluate/stream`, `/v1/graphql`) are separate from this list and are properly gated at the tenant level (`FeatureNotEnabledError` on 404).

## Vault cron secret requirement (atlasent-api operators)

**Correction (2026-09-06, Layer 10 observability/incident-ops audit) — the gap this section describes is FIXED on atlasent-api's own runtime prod/staging projects; do not read the paragraph below as current for those.** `atlasent-api`'s own `docs/runbooks/CRON_VAULT_SECRETS.md` records **"secrets created 2026-07-07 by bettyc925 — all 8 crons live"**, independently corroborated by that repo's `docs/MIGRATION_LOG.md` ("OPS COMPLETE 2026-07-07 ... All 8 crons are now live"). This section had not been updated to reflect that fix — verified directly against both source documents rather than assumed from this repo's own text, per this program's standing "a runbook claim is not evidence, check the target directly" doctrine. The original text is preserved below because it remains accurate for exactly the scenario it names — **a self-hosted or freshly-provisioned atlasent-api runtime project** — where these Vault secrets have not yet been created and this remains a real, live setup step, not a historical curiosity.

If you are running this MCP server against a **self-hosted or fresh atlasent-api** runtime project, be aware that 8 runtime HTTP cron jobs have never fired since creation on managed Supabase instances. These crons were re-pointed to read their bearer secrets from Vault (migration `20260702000000_crons_vault_secret_migration.sql`) because `current_setting('app.*')` GUCs are not settable on managed Supabase (`42501` permission error).

**Until the following Vault secrets are created, those crons post a NULL bearer and receive 401 (fail-safe, no enforcement effect):**

| Vault secret name | Cron it enables |
|---|---|
| `ATLASENT_AUDIT_SIGN_SWEEP_WORKER_SECRET` | `audit-sign-reconciliation-sweep` |
| `ATLASENT_CHAIN_ANCHOR_WORKER_SECRET` | `chain-anchor-every-5min` |
| `ATLASENT_BILLING_ADMIN_SECRET` | `governed-action-stripe-sync` |
| `ATLASENT_EVIDENCE_SCHEDULER_SECRET` | `evidence-scheduler-sweep` |
| `ATLASENT_BVS_WORKER_SECRET` | `bvs-observe-hourly`, `bvs-adjustment-engine-5min` |
| `ATLASENT_DELEGATION_SHADOW_WORKER_SECRET` | `delegation-shadow-every-5min` |
| `supabase_functions_base_url` | All of the above (functions base URL) |

See `atlasent-api/docs/runbooks/CRON_VAULT_SECRETS.md` for the full setup procedure (and its current "all 8 live" status on atlasent-api's own runtime projects, per the correction above). This does not affect MCP server behavior directly (the MCP server calls evaluate/verify synchronously), but audit-chain signing, chain anchoring, and billing sync will be silently broken on a new runtime deployment until these secrets are set.

## npm publishing

Scoped package `@atlasent/mcp-server`, `publishConfig.access: public`. Tag `v*` triggers `publish.yml`, which runs an AtlaSent `package.release` gate, then build, tests, and `npm publish --access public` using the `NPM_TOKEN` repo secret. **Not `--provenance`** — provenance requires a public source repo, and this repo is private; a cosign keyless-signed tarball (uploaded as a build artifact) is the supply-chain attestation instead. **Correction (2026-08-30):** this section previously claimed no `v*` tag had ever been pushed and no version had ever been published — that was based on an incomplete local git clone (`git tag -l` empty), not the live registry. Verified directly against `registry.npmjs.org`: **`2.11.0` has been published to npm since 2026-06-09** (via a manual `workflow_dispatch` run, not a tag-triggered one), and the `v2.11.0` git tag has existed on GitHub since 2026-06-10 (`create-v2-11-0-tag.yml` run #1, which pinned it to a specific historical commit SHA rather than the HEAD at dispatch time). Before assuming a tag or version is missing, check the live registry/GitHub state directly rather than a local checkout's `git tag -l`, which may not have fetched tags. Submission to the **MCP Registry remains genuinely outstanding** — confirmed via a live query against `registry.modelcontextprotocol.io` returning zero results.

## MCP Registry publishing

`server.json` (repo root) is the official MCP Registry manifest
(`io.github.atlasent-systems-inc/mcp-server`). After every successful npm
publish, `publish-mcp-registry.yml` publishes it to
registry.modelcontextprotocol.io via `mcp-publisher` with GitHub OIDC (no
stored secret). **Release checklist addition: bump BOTH version fields in
`server.json` (top-level and `packages[0].version`) together with
`package.json`** — the workflow fails closed on a mismatch. First-time
publication (and re-publishes) can be run manually via workflow_dispatch.
`smithery.yaml` covers the Smithery directory separately.
