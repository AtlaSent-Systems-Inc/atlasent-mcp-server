# @atlasent/mcp-server

**Govern every AI agent action in 60 seconds.**

AtlaSent's MCP server plugs into any [Model Context Protocol](https://modelcontextprotocol.io)-compatible agent — Claude Desktop, Cursor, Copilot, LangChain, and more. Every action the agent takes is evaluated against your policies before execution and verified after. If an action is unauthorized, it's denied before anything happens. No code changes required.

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_API_KEY": "as_live_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_API_KEY": "as_live_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Cursor. AtlaSent appears in **Settings > MCP** as a connected server.

### Claude Code

```bash
claude mcp add atlasent -- npx -y @atlasent/mcp-server
```

Set your API key via environment variable before launching:

```bash
export ATLASENT_API_KEY="as_live_xxxxxxxxxxxxxxxx"
```

### Any MCP Client

The server speaks [stdio transport](https://modelcontextprotocol.io/docs/concepts/transports#stdio). Point your MCP client at:

```
npx -y @atlasent/mcp-server
```

Pass `ATLASENT_API_KEY` as an environment variable.

## How It Works

The server exposes two tools that form a **governance loop** around every agent action:

```
  Agent wants to act
        │
        ▼
  ┌─────────────┐     ┌──────────────────────────┐
  │  evaluate    │────▶│ AtlaSent Policy Engine    │
  └─────────────┘     │ • Who is the actor?       │
        │             │ • What are they doing?     │
        ▼             │ • In which environment?    │
   allow / deny       │ • Do they have approvals?  │
   / escalate         │ • Is it the right window?  │
        │             └──────────────────────────┘
        ▼
  Agent performs action (only if allowed)
        │
        ▼
  ┌─────────────────┐
  │  verify_permit   │──▶ Closes the audit loop
  └─────────────────┘
```

### `evaluate`

Called **before** the agent acts. Sends the action context to AtlaSent and returns a decision.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action_type` | `string` | yes | What the agent is doing (`deploy`, `delete`, `execute_query`, `send_email`) |
| `actor_id` | `string` | yes | User or service account the agent acts on behalf of |
| `environment` | `string` | yes | Target environment (`production`, `staging`, `development`) |
| `approvals` | `string[]` | no | Approval IDs already obtained (ticket IDs, reviewer handles) |
| `change_window` | `string` | no | ISO-8601 time window (`2025-01-15T02:00:00Z/PT4H`) |

**Returns:**

```json
{
  "decision": "allow",
  "permit_token": "pt_abc123...",
  "audit_id": "aud_789...",
  "conditions": ["requires_two_person_review"]
}
```

### `verify_permit`

Called **after** the agent completes the action. Confirms the action was performed within its authorized scope.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `permit_token` | `string` | yes | Token from the prior `evaluate` call |
| `action_type` | `string` | yes | Same action type as the evaluate call |
| `actor_id` | `string` | yes | Same actor |
| `environment` | `string` | yes | Same environment |
| `approvals` | `string[]` | no | Approvals obtained |
| `change_window` | `string` | no | Change window |

**Returns:**

```json
{
  "outcome": "verified",
  "valid": true,
  "audit_id": "aud_789..."
}
```

## What Happens When an Agent Tries an Unauthorized Action

When an agent connected to AtlaSent attempts something it shouldn't — say, deploying to production without approvals during a change freeze — here's what happens:

**1. The agent calls `evaluate` before acting:**
```json
{
  "action_type": "deploy",
  "actor_id": "eng-intern-jane",
  "environment": "production"
}
```

**2. AtlaSent denies the action:**
```json
{
  "decision": "deny",
  "reason": "Policy violation: production deploys require at least one approval and an active change window. No approvals provided; no change window specified."
}
```

**3. The agent stops.** The tool description instructs the agent that it MUST NOT proceed when the decision is `deny`. The agent will inform the user:

> *"I'm unable to deploy to production. AtlaSent policy requires at least one approval and a scheduled change window. Would you like me to deploy to staging instead, or help you request an approval?"*

**4. If the API is unreachable or returns an error**, the server fails closed — it returns `deny` automatically. No silent failures, no default-allow.

## The Audit Trail

Every `evaluate` and `verify_permit` call is recorded by AtlaSent. Your dashboard shows:

| Timestamp | Actor | Action | Environment | Decision | Permit | Verified |
|---|---|---|---|---|---|---|
| 2025-01-15 14:32:01 | `eng-intern-jane` | `deploy` | `production` | **deny** | — | — |
| 2025-01-15 14:32:45 | `eng-intern-jane` | `deploy` | `staging` | **allow** | `pt_abc123` | yes |
| 2025-01-15 15:01:12 | `eng-lead-alex` | `deploy` | `production` | **allow** | `pt_def456` | yes |
| 2025-01-15 15:10:03 | `agent-copilot-7` | `delete` | `production` | **deny** | — | — |

Every agent action has a paper trail. You can see who did what, when, whether it was allowed, and whether the permit was verified after execution. Unverified permits (action was allowed but `verify_permit` was never called) are flagged automatically.

## Configuration

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `ATLASENT_API_KEY` | yes | — | Your AtlaSent API key |
| `ATLASENT_ANON_KEY` | no | — | Public/anonymous key (sent as `x-anon-key` header) |
| `ATLASENT_BASE_URL` | no | `https://api.atlasent.com` | AtlaSent API base URL |

## Fail-Closed by Design

This server treats safety as a hard constraint, not a preference:

- **API unreachable?** → deny
- **Request timeout?** → deny (10 second limit)
- **Malformed response?** → deny
- **Any exception?** → deny

The agent never proceeds without an explicit `allow` from AtlaSent.

## Development

```bash
git clone https://github.com/AtlaSent-Systems-Inc/mcp-server.git
cd mcp-server
npm install
npm run build
npm test
```

### Integration tests

Run against a live AtlaSent API:

```bash
ATLASENT_API_KEY=your-key npm run test:integration
```

Without `ATLASENT_API_KEY` set, integration tests skip automatically.

## Publishing

To publish a new version:

1. Add `NPM_TOKEN` to GitHub repo secrets
2. Tag and push:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The CI workflow builds, tests, and publishes to npm automatically.

## License

[MIT](LICENSE)
