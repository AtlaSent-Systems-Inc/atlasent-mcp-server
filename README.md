# @atlasent/mcp-server

MCP server that exposes the AtlaSent governance API as [Model Context Protocol](https://modelcontextprotocol.io) tools. Plug it into Claude Desktop, Cursor, Claude Code, or any MCP-compatible agent and the agent can evaluate actions, inspect policies, read audit events, resolve approvals, and verify permits through the hosted AtlaSent backend.

v2 is an API-only client: every tool proxies a single AtlaSent REST endpoint. There is no embedded policy engine and no local mode.

## Install

```bash
npm install -g @atlasent/mcp-server
```

Or run on demand via `npx -y @atlasent/mcp-server`.

## Configure

The server reads two required env vars on startup and exits if either is missing:

| Variable | Purpose |
|---|---|
| `ATLASENT_API_URL` | Base URL of the AtlaSent API (e.g. `https://api.atlasent.io`) |
| `ATLASENT_API_KEY` | API key; sent as `X-AtlaSent-Key` on every request |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `ATLASENT_ORG_ID` | — | Org scoping header (passthrough) |
| `ATLASENT_TIMEOUT` | `10000` | Request timeout in ms |

## Tools

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `evaluate_action` | `POST /v1/evaluate` | Evaluate whether an action is allowed under active policies |
| `get_session` | `GET /v1/session` | Session details for the current API key |
| `list_audit_events` | `GET /v1/audit/events` | List audit events with optional filters |
| `list_policies` | `GET /v1/policies` | List policies in the org |
| `get_policy` | `GET /v1/policies/:id` | Get one policy with its rules |
| `list_approvals` | `GET /v1/approvals` | List approval requests |
| `resolve_approval` | `POST /v1/approvals/:id/resolve` | Approve or reject a request |
| `verify_permit` | `POST /v1/permits/:id/verify` | Verify a permit is still active |
| `consume_permit` | `POST /v1/permits/:id/consume` | Mark a permit as used |
| `get_report` | `GET /v1/reports` | Governance summary report for a time range |

Each tool returns the API's JSON response. Non-2xx responses are surfaced as `isError: true` tool results with the API error message.

## Claude Desktop config

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

File location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## Cursor config

Add the same `mcpServers` block to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally).

## Claude Code

```bash
claude mcp add atlasent -- npx -y @atlasent/mcp-server
export ATLASENT_API_URL=https://api.atlasent.io
export ATLASENT_API_KEY=atk_live_xxxxxxxxxxxxxxxx
```

## v1 → v2 migration

v1 was an embedded authorize-before-execute engine with its own policy rules. v2 removes the engine and proxies every tool through the AtlaSent API. Rename your config env vars:

| v1 | v2 |
|---|---|
| `ATLASENT_BASE_URL` | `ATLASENT_API_URL` |
| `ATLASENT_API_KEY` (Bearer) | `ATLASENT_API_KEY` (X-AtlaSent-Key) |
| `ATLASENT_MODE` | (removed — no local mode) |

See `docs/DESIGN_V2.md` for details.

## Development

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run dev          # tsx src/index.ts (requires env vars)
npm start            # node dist/index.js (after build)
```

## License

[MIT](LICENSE)
