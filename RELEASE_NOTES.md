# Release Notes — v2.0.0

**Release date:** 2026-04-19

## AtlaSent MCP Server v2.0.0 (breaking)

v2 is a full rewrite of the tool surface. The server is now a thin client over the AtlaSent REST API: every tool proxies a single endpoint and returns the response verbatim. The embedded authorization engine, local mode, and in-process rules from v1 are gone.

### Breaking changes

- **Tools renamed and expanded.** The v1 `evaluate` + `verify_permit` pair is replaced with ten endpoint-backed tools. See the table below.
- **Env vars renamed.** `ATLASENT_BASE_URL` → `ATLASENT_API_URL`. `ATLASENT_API_KEY` is now sent as the `X-AtlaSent-Key` header (v1 used `Authorization: Bearer`).
- **Local mode removed.** `ATLASENT_MODE` is no longer read. Both `ATLASENT_API_URL` and `ATLASENT_API_KEY` are required on startup.
- **`deploy_service` demo tool removed.** It was a v1 illustration of the authorize-before-execute pattern; v2 has no interception layer.

### Tools exposed

| Tool | Endpoint | Purpose |
|---|---|---|
| `evaluate_action` | `POST /v1/evaluate` | Evaluate whether an action is allowed |
| `get_session` | `GET /v1/session` | Session details for the API key |
| `list_audit_events` | `GET /v1/audit/events` | List audit events with optional filters |
| `list_policies` | `GET /v1/policies` | List policies in the org |
| `get_policy` | `GET /v1/policies/:id` | Get one policy with its rules |
| `list_approvals` | `GET /v1/approvals` | List approval requests |
| `resolve_approval` | `POST /v1/approvals/:id/resolve` | Approve or reject a request |
| `verify_permit` | `POST /v1/permits/:id/verify` | Verify a permit is still active |
| `consume_permit` | `POST /v1/permits/:id/consume` | Mark a permit as used |
| `get_report` | `GET /v1/reports` | Governance summary for a time range |

### Config

Required:

- `ATLASENT_API_URL` — base URL of the AtlaSent API
- `ATLASENT_API_KEY` — API key (sent as `X-AtlaSent-Key`)

Optional:

- `ATLASENT_ORG_ID` — org scoping; sent as `X-AtlaSent-Org` when set
- `ATLASENT_TIMEOUT` — request timeout in ms (default `10000`)

### Install (Claude Desktop)

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_API_URL": "https://api.atlasent.io",
        "ATLASENT_API_KEY": "atk_live_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Node version

Requires Node.js ≥ 20. v1 supported Node 18.

### v1 → v2 migration

1. Update your config env vars: rename `ATLASENT_BASE_URL` to `ATLASENT_API_URL`; remove `ATLASENT_MODE` if set.
2. Replace any calls to `evaluate` with `evaluate_action` (arguments changed — see the tool schema).
3. Drop `deploy_service` and similar illustration-only integrations; v2 expects domain tools to call `evaluate_action` out-of-band.

See `docs/DESIGN_V2.md` for the full rationale.

---

# Release Notes — v1.0.0

**Release date:** 2026-04-17

## AtlaSent MCP Server v1.0.0

First stable release of the AtlaSent MCP server. Works with Claude Desktop, Cursor, Claude Code, and any MCP-compatible client.

### Tools exposed

| Tool | Description |
|---|---|
| `evaluate` | Authorize an action — returns `decision`, `permit_token`, `audit_hash` |
| `verify_permit` | Consume a permit at execution time — enforces single-use |

### Modes

- **Local mode** (no API key): In-process rules engine, zero network calls. Ideal for demos and offline development.
- **Remote mode** (`ATLASENT_API_KEY` set): Routes to the hosted AtlaSent backend. Full audit chain, multi-org policies.

### Install (Claude Desktop)

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_API_KEY": "as_live_xxx" }
    }
  }
}
```

### Local demo (no credentials)

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server
cd atlasent-mcp-server && npm install && npm run demo
```

### Stability guarantees

The `evaluate` and `verify_permit` tool schemas are stable as of v1.0.0. Tool names and required parameters will not change without a major version bump.
