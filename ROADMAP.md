# atlasent-mcp-server — roadmap

> Owner: AtlaSent
> Status (2026-04-30): **P1** — track for v1
> Umbrella roadmap: https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ROADMAP.md

This MCP server is the gate that wraps the canonical [`@atlasent/types`](https://github.com/AtlaSent-Systems-Inc/atlasent/tree/main/packages/types) wire contract for any [Model Context Protocol](https://modelcontextprotocol.io) host (Claude Desktop, Cursor, Claude Code, Copilot, LangChain). Every protected tool call hits `authorize()` before execution; the host never sees the action run unless the canonical engine returned `allow` and issued a single-use permit.

The one invariant: **if `authorize()` does not return `allow`, the action code never runs.**

## What v1 must ship

| # | Item | Status |
|---|---|---|
| 1 | Canonical wire alignment — `POST /v1/evaluate` + `POST /v1/verify-permit`, `{actor, action, target, context}` body | ✅ this branch |
| 2 | Decision union mirrors `@atlasent/types`: `allow \| deny \| hold \| escalate` | ✅ this branch |
| 3 | Single CLI entry (`src/index.ts`) — createServer + register resources + transport | ✅ this branch |
| 4 | Stdio + HTTP transports (StreamableHTTP preferred, SSE fallback) | ✅ already in `http-transport.ts` |
| 5 | `evaluate`, `verify_permit`, `deploy_service` tools | ✅ already in `server.ts` |
| 6 | `atlasent://policies/{id}` resource | ✅ already in `resources.ts` |
| 7 | Fail-closed wrapper (every error → `deny`) + 10 s remote timeout | ✅ already in `engine.ts` |
| 8 | Local rules engine for offline demo (no credentials) | ✅ already in `localEngine.ts` |
| 9 | Unit tests (`server.test.ts`) green; nightly integration tests against hosted API | ✅ existing |
| 10 | npm publish on `v*` tag, `--provenance`, scoped package `@atlasent/mcp-server` | ✅ existing workflow |
| 11 | Drop the orphan v2 surface (`client.ts`, `config.ts`, old `index.ts` tools list) | follow-up PR |
| 12 | README pass to reflect canonical contract + escalate decision | follow-up PR |

## Out of scope for v1

- Server-side rule authoring (lives in `atlasent-api`)
- Audit chain export (lives in `atlasent-api`, surfaced via `atlasent-console`)
- v2 anything — see umbrella ROADMAP § One-API-version lock

## Sibling repos this depends on

- [`atlasent`](https://github.com/AtlaSent-Systems-Inc/atlasent) — canonical types live in `packages/types`. Any change to wire shape originates there.
- [`atlasent-api`](https://github.com/AtlaSent-Systems-Inc/atlasent-api) — implements `/v1/evaluate` and `/v1/verify-permit`. Endpoint paths and headers must match.
- [`atlasent-sdk`](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk) — TS reference enforcement client. The MCP server's wire layer is a thin restatement of the SDK's HTTP layer.

## Release sequencing

1. Land canonical wire alignment (this branch).
2. Cut `v2.0.1` (engine.ts internals only — no breaking change to MCP tool surface).
3. After umbrella v1 tag: drop the orphan v2 surface (`client.ts`, `config.ts`, old `index.ts` tools); cut `v2.1.0`.
4. Mirror npm `latest` to GA tag once umbrella `v1.0.0` is published.
