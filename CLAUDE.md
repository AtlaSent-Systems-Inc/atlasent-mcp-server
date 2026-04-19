# @atlasent/mcp-server

MCP server that exposes AtlaSent's REST API as Model Context Protocol tools for AI agents. Every tool is a thin proxy over an `atlasent-api` endpoint — no direct Supabase or other backend access.

## Architecture

```
src/
  index.ts    — CLI entry point; stdio transport; registers the 10 tools and dispatches each to the API
  config.ts   — loadConfig() reads ATLASENT_API_URL + ATLASENT_API_KEY; apiRequest() is the shared fetch wrapper
  client.ts   — AtlaSentApiClient: standalone client class (not used by index.ts, kept for external consumers)

docs/
  DESIGN_V2.md  — v1 → v2 migration notes (dropped Supabase, moved to API-only)

examples/
  claude_desktop_config.json — MCP client config snippet for Claude Desktop
```

## Tools

All tools proxy to the AtlaSent API and return its JSON response verbatim. Errors are caught and returned as `isError: true` tool results.

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `evaluate_action` | `POST /v1/evaluate` | Decide whether an action is allowed |
| `get_session` | `GET /v1/session` | Session details for the API key |
| `list_audit_events` | `GET /v1/audit/events` | Audit log with optional filters |
| `list_policies` | `GET /v1/policies` | Policies in the org |
| `get_policy` | `GET /v1/policies/:id` | One policy with its rules |
| `list_approvals` | `GET /v1/approvals` | Approval requests |
| `resolve_approval` | `POST /v1/approvals/:id/resolve` | Approve/reject a request |
| `verify_permit` | `POST /v1/permits/:id/verify` | Verify a permit is still valid |
| `consume_permit` | `POST /v1/permits/:id/consume` | Mark a permit as used |
| `get_report` | `GET /v1/reports` | Governance summary for a time range |

## Request contract

`apiRequest(config, path, init)`:

- Base URL: `config.apiUrl` (trailing slash stripped)
- Auth header: `X-AtlaSent-Key: <config.apiKey>`
- `Content-Type: application/json`
- Errors: non-2xx responses throw `Error(\`${err.code ?? 'api_error'}: ${err.message ?? 'Request failed'} (${status})\`)`, which index.ts surfaces as an `isError` tool result.

## Config

Required env vars (`config.ts` throws on startup if missing):

- `ATLASENT_API_URL` — base URL of the AtlaSent API (e.g. `https://api.atlasent.io`)
- `ATLASENT_API_KEY` — API key; sent as `X-AtlaSent-Key`

Optional:

- `ATLASENT_ORG_ID` — org scoping (passthrough)
- `ATLASENT_TIMEOUT` — request timeout in ms (default 10_000); not yet wired into `apiRequest` — currently informational.

## Build, run

```bash
npm run build             # tsc → dist/
npm run typecheck         # tsc --noEmit
npm run dev               # tsx src/index.ts (requires env vars)
npm start                 # node dist/index.js (requires env vars and a build)
```

No test suite in v2. Previous v1 tests covered a different architecture (authorize/verify/hold) and were removed with the v1 code.

## npm publishing

Scoped package `@atlasent/mcp-server@2.0.0`, ESM-only (`"type": "module"`). Only dependency: `@modelcontextprotocol/sdk`.
