# atlasent-mcp-server — V2 Rollout

> **Doctrine normalization header (2026-05-18).** This file is
> preserved unchanged below per Doctrine 4 of
> [`atlasent/VERSIONING_DOCTRINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/normalize-roadmap-versioning-NWPuP/VERSIONING_DOCTRINE.md).
> Under the current doctrine there is no "v2 product"; the work
> described here splits across **Phase 1** (Streamable HTTP transport,
> SDK 2.x adoption, batch/stream/GraphQL tool surfaces — additive on
> the `AtlaSent v1` contract) and **Phase 2** (behavior-aware tool
> gating, fail-closed audit). The filename, `B.MCP#` / `C.MCP#`
> identifiers, and code-level flag names (`v2_mcp_streamable_http`,
> `v2_batch`, `v2_streaming`, `v2_graphql`,
> `v2_behavior_conditioning`) are retained per Doctrine 4. The npm
> package SemVer `@atlasent/mcp-server@1.0.0` is the package release
> (Doctrine 5), independent of the platform.

> **Reframing normalization header (2026-05-18).** This document
> remains in scope and is preserved unchanged per the "do not rewrite
> history" doctrine ([`atlasent/VERSIONING_DOCTRINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/VERSIONING_DOCTRINE.md)
> doctrine 4). Under the 2026-05-18 platform-generation reframing,
> the work described here is reclassified as the **v1.x capability
> layer** — additive cash-flowing capabilities on top of the V1 GA
> substrate. The platform-generation label **v2** now refers to the
> full enterprise surface, planned in
> [`atlasent/ENTERPRISE_V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ENTERPRISE_V2_ROLLOUT.md).
> Filename and `V2-D#` identifiers are retained for reference
> stability; "V2" in this document refers to the historical pre-reframing
> framing, not the post-reframing platform-generation v2. New
> decisions use the **`PROD-D#`** namespace. See
> [`atlasent/ROADMAP.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ROADMAP.md)
> for the current generation matrix.

**Status:** plan · **Wave:** B (transport) + C (tool surface) · **Updated:** 2026-05-15

> **V1 GA — 2026-05-17.** V1 substrate frozen — the canonical foundation
> this V2 plan extends. The `/v1/*` wire surface, schema, audit chain,
> and Ed25519-signed export envelope are stable; V2 work in this plan is
> **additive** on V1 (no V1 wire/schema/audit-chain changes ship under V2).
> V2 implementation is unblocked pending umbrella
> [`V2_DECISIONS.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/V2_DECISIONS.md) sign-off.
> Canonical V1 reference: [`atlasent-api/docs/runtime/golden-path-v1.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/runtime/golden-path-v1.md).
> V1 GA closeout PRs: see umbrella [`ROADMAP.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ROADMAP.md) "V1 GA — what closed" section.

MCP server cut of the [umbrella v2 rollout](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/plan-v2-rollout-5IPGF/V2_ROLLOUT.md). Owns the `v2_mcp_streamable_http` flag in `atlasent-control-plane`. Adds batch / stream / GraphQL tool surfaces and behavior-aware tool gates. Closes the gap noted in `atlasent-docs/plans/atlasent-mcp-server.md` (v0.3 → v1.0).

## Position

`@atlasent/mcp-server` plugs into MCP hosts (Claude Desktop, Cursor, Claude Code, Copilot, LangChain) and runs the `evaluate → act → verify` loop. Today it speaks the MCP 2024-11-05 stdio + SSE transport and offers 14 tools plus a `deploy_service` demo. v2 ships the **Streamable HTTP transport** (MCP 2025-03-26), wraps the new atlasent-api batch/stream/graphql endpoints, and adds behavior-aware tool gating. Local mode (the in-process rules engine) stays untouched — the v2 surface is remote-only.

## v2 deliverables

### Wave B — Transport + core tools

| ID | Item | Status |
|---|---|---|
| B.MCP1 | **Streamable HTTP transport** (MCP 2025-03-26) — new entry alongside stdio + SSE; auth via `ATLASENT_API_KEY` bearer; resumable session per spec | pending — gated `v2_mcp_streamable_http` |
| B.MCP2 | `atlasent_evaluate_many` tool — wraps `client.evaluateMany`; per-call cap 100 (matches api Wave A) | pending — gated `v2_batch` |
| B.MCP3 | `atlasent_authorize_stream` tool — wraps `client.authorizeStream`; emits `decision`, `risk-update`, `permit-revoked` as MCP progress notifications | pending — gated `v2_streaming` |
| B.MCP4 | `atlasent_graphql_query` tool — read-only passthrough to `/v1/graphql`; admin-key gated (`scopes` includes `audit:read` or `admin:read`) | pending — gated `v2_graphql` |
| B.MCP5 | SDK 2.x adoption — `src/engine.ts` remote path moves from inline `fetch` to `@atlasent/sdk@^2`; local mode unchanged | gated on `atlasent-sdk` B.SDK11 publish |

### Wave C — Behavior-aware + safety

| ID | Item | Status |
|---|---|---|
| C.MCP1 | **Behavior-aware tool gates** — when an upstream MCP host wraps a wellness-app tool, the server auto-attaches `context.user_state` + `context.bvsSnapshot` to `authorize()` via `@atlasent/behavior`; `escalate` decisions surface as a distinct MCP error code so the host can route to human review | pending — gated `v2_behavior_conditioning` |
| C.MCP2 | **Read-only mode extension** — extend `ATLASENT_MCP_READONLY=1` to skip-register the new mutating tools as they land (GraphQL mutations when atlasent-api lifts them off REST, future `atlasent_*` writes) | pending |
| C.MCP3 | **Fail-closed audit** — every Streamable HTTP request produces a `mcp.request` audit event tagged with `session_id`, `transport: "streamable-http"`, `tool_name`; collapses to MCP error envelope on api unreachable | pending |
| C.MCP4 | **v1.0 release** — cut `v1.0.0` after C.MCP1–C.MCP3 land + 2.x SDK adopted; npm publish under `@atlasent/mcp-server@1.0.0` | gated on all above |

## Tenant-flag matrix

| Flag | Module |
|---|---|
| `v2_mcp_streamable_http` | B.MCP1 |
| `v2_batch` | B.MCP2 |
| `v2_streaming` | B.MCP3 |
| `v2_graphql` | B.MCP4 |
| `v2_behavior_conditioning` | C.MCP1 |

Flags resolve via the same `flagsClient` pattern other repos use, hitting `atlasent-control-plane` on tool-registration. In `local` mode flags are inert — the local engine never speaks v2.

## Behavior-aware gates (C.MCP1)

The current `atlasent_evaluate` tool passes `{ subject, action, resource, context }` through. With `v2_behavior_conditioning=true`, the server additionally:

1. If `context.user_id` is present, reads the user's redacted `StateEvent` summary via `@atlasent/behavior`.
2. Adds `context.user_state` and `context.bvsSnapshot` to the evaluate request — same aggregates-only contract as `langchain-llamaindex-integration` C.LL6.
3. Maps a returned `decision: "escalate"` to a new MCP error class `atlasent_escalate` (distinct from `atlasent_deny`) so hosts route to human review instead of refusing silently.

The server never reads raw event text — only the same redacted projection that crosses the LedgersMe boundary.

## Sequencing

1. B.MCP1 (Streamable HTTP transport) — can land before SDK 2.x; transport is independent of tool wiring.
2. B.MCP5 (SDK 2.x adoption) — must precede B.MCP2/B.MCP3/B.MCP4 since they consume new SDK methods.
3. B.MCP2 + B.MCP3 + B.MCP4 — parallel after B.MCP5.
4. C.MCP1 (behavior-aware gates) — needs `@atlasent/behavior` from `atlasent-sdk` B.SDK9.
5. C.MCP2 + C.MCP3 — small; bundle with C.MCP1.
6. C.MCP4 (v1.0 cut) — last; all of the above shipped, integration tests green, demo updated.

## Cross-repo dependencies

- **atlasent-sdk**: B.SDK11 (npm publish of `@atlasent/sdk@^2`), B.SDK9 (`@atlasent/behavior`)
- **atlasent-api**: `/v1/evaluate/{batch,stream}`, `/v1/graphql`, signed-permit-token wire shape
- **atlasent-control-plane**: tenant flags above; the `flagsClient` already drafted in CP PR #6
- **behavior-insights**: BI2/BI3 (read API + sensitive-category aggregates) — gates C.MCP1
- **atlasent-docs**: `atlasent-docs/plans/atlasent-mcp-server.md` (v0.3 → v1.0 milestone tracking)

## Out of scope for v2

- Mutating GraphQL via `atlasent_graphql_mutation` — gated until atlasent-api lifts mutations off REST (post-Wave-A)
- WebSocket transport — Streamable HTTP supersedes; not pursuing
- Local-mode behavior conditioning — local engine intentionally has no behavior context; remote-only
- Multi-tenant API-key rotation UX from inside the server — operator console territory

## Open questions

- Streamable HTTP session storage: in-process map (single-instance ok) vs Redis (multi-instance hosting)? Default ships in-process; document the upgrade path.
- C.MCP1 escalate-error surface: new MCP error class (`atlasent_escalate`), or reuse `atlasent_deny` with a `reason_class: "escalate"` field? LangChain plan (`C.LL6`) leans toward distinct error.
- B.MCP4 admin-scope gate: `audit:read` is enough for read-only GraphQL, but org membership scoping is currently SDK-side. Should the MCP server validate org membership before forwarding?
- v1.0 release semantics: publish to npm under `@atlasent/mcp-server@1.0.0` (drops the 0.x), or stay 0.x until Streamable HTTP is GA in the MCP spec ecosystem?
- Should `deploy_service` demo gain a streaming variant to showcase B.MCP3 in the 60-second demo?

## Cross-repo links

- Umbrella plan: [`atlasent/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/plan-v2-rollout-5IPGF/V2_ROLLOUT.md)
- API plan: [`atlasent-api/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/V2_ROLLOUT.md)
- SDK plan: this branch, sibling repo
- Control-plane plan: [`atlasent-control-plane/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-control-plane/blob/main/V2_ROLLOUT.md)
- LangChain plan (parallel behavior gates): [`langchain-llamaindex-integration/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/langchain-llamaindex-integration/blob/main/V2_ROLLOUT.md)
- Per-repo milestone doc: [`atlasent-docs/plans/atlasent-mcp-server.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/plans/atlasent-mcp-server.md)
