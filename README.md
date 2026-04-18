# @atlasent/mcp-server

**Authorize every AI agent tool call before it executes.**

An MCP server that plugs into any [Model Context Protocol](https://modelcontextprotocol.io)-compatible agent (Claude Desktop, Cursor, Claude Code, Copilot, LangChain) and enforces a simple contract: *no protected action runs until AtlaSent has authorized it*. Denied calls never reach the target system. Allowed calls return a permit token you can verify afterwards to close the audit loop.

Ships with a local rules engine so you can run the full evaluate → act → verify flow in under a minute, with zero credentials. The hosted AtlaSent backend is a configuration swap, not a rewrite.

## Run the demo in 60 seconds

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server.git
cd atlasent-mcp-server
npm install
npm run build
npm run demo
```

You'll see three scenarios run end-to-end:

```
Scenario A: agent attempts unauthorized deploy (prod, no approvals)
    [1] Agent calls deploy_service
    [2] MCP intercepts → calls authorize(ctx) → policy engine decides
    [3] Tool execution BLOCKED
        ✓ deploy did NOT run. The target system was not touched.
        ✓ reason: Production action 'deploy' requires at least one approval...

Scenario B: agent attempts authorized deploy (prod, with approval)
    [1] Agent calls deploy_service with approval
    [2] MCP intercepts → calls authorize(ctx) → policy engine decides
    [3] Tool execution PROCEEDS
        result: {"status":"deployed","service":"billing-api",...}

Scenario C: close the audit loop with verify_permit
    result: {"outcome":"verified","valid":true,...}
```

The demo uses `local` mode (no API key needed). To run the same demo against the hosted AtlaSent backend once your API key is issued:

```bash
ATLASENT_MODE=remote \
  ATLASENT_API_KEY=as_live_xxx \
  ATLASENT_BASE_URL=https://api.atlasent.com \
  npm run demo
```

## Tools

### `evaluate` — for agents that gate themselves

The agent calls `evaluate` before any sensitive action and respects the decision.

```
Input:  { action_type, actor_id, environment, approvals?, change_window? }
Output: { decision: "allow" | "deny" | "hold", permit_token?, reason?, audit_id?, ... }
```

### `verify_permit` — close the audit loop

After the action runs, the agent calls `verify_permit` with the issued token.

```
Input:  { permit_token, action_type, actor_id, environment, ... }
Output: { outcome: "verified" | "expired" | "invalid" | "error", valid: boolean, ... }
```

### `deploy_service` — demo of the interception pattern

A protected tool that authorizes itself before executing. Every call:

1. Builds an action context from the tool arguments
2. Calls `authorize(ctx)` — **this is the interception point**
3. If the decision is anything other than `allow`, returns the decision and does NOT execute
4. On `allow`, runs the deploy and returns the result plus the permit token

See `src/server.ts` (the `deploy_service` handler) for the exact 20-line pattern every protected tool should follow. In production, your domain tools live on other MCP servers and call AtlaSent's `evaluate` tool before executing; this demo co-locates them so you can see the full flow today.

## Execution Flow

```
  ┌─────────────┐
  │    Agent     │  wants to call a protected tool
  └─────┬───────┘
        │
        ▼
  ┌─────────────────────────┐
  │    Protected tool       │
  │  (e.g. deploy_service)  │
  └─────┬───────────────────┘
        │ (1) build ActionContext
        ▼
  ┌─────────────────┐       ┌──────────────────────────┐
  │  authorize(ctx)  │──────▶│  engine (local | remote)  │
  └─────┬───────────┘       └────────┬─────────────────┘
        │ (2) Decision               │
        │   allow | deny | hold      │
        ▼                            ▼
  ┌──────────────────────────────────────────┐
  │  decision === "allow"?                    │
  └──┬───────────────────────┬───────────────┘
     │ no                    │ yes
     ▼                       ▼
  BLOCKED              (3) execute the action
  return decision            │
                             ▼
                      (4) return { decision, permit_token, result }
                             │
                             ▼
                      later: verify_permit closes the audit loop
```

The **interception point** is step (2): `authorize()` runs before the action. That's the entire guarantee — if `decision !== "allow"`, the action does not run.

## Decision envelope

Every authorization result uses the same shape, so agents and hosts handle all outcomes uniformly:

```ts
type Decision =
  | { decision: "allow";  permit_token: string; audit_id?: string; conditions?: string[] }
  | { decision: "deny";   reason: string;       audit_id?: string }
  | { decision: "hold";   reason: string;       hold_id?: string; audit_id?: string };
```

Verification has a parallel shape:

```ts
type VerifyResult = {
  outcome: "verified" | "expired" | "invalid" | "error";
  valid: boolean;
  reason?: string;
  audit_id?: string;
};
```

**Handling each case:**

| Decision | Agent behavior |
|---|---|
| `allow` | Proceed. Pass `permit_token` to `verify_permit` after completing the action. |
| `deny` | Do not proceed. Surface `reason` to the user. |
| `hold` | Do not proceed. Tell the user the action is queued for human review; reference `hold_id`. |
| **verification failure** (verify returns `valid: false` or `outcome: "error"`) | Flag the action for review. Something happened outside policy. |

## Local vs Remote mode

The engine behind `authorize()` is pluggable. The same tool handlers work in both modes — swapping the backend is a configuration change.

| Mode | When selected | What it does |
|---|---|---|
| `local` | `ATLASENT_MODE=local`, or both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are unset | Runs a small in-process rules engine (`src/localEngine.ts`) — no network, no credentials |
| `remote` | `ATLASENT_MODE=remote`, or both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are set | Calls the hosted AtlaSent backend at `POST /v1-evaluate` and `POST /v1-verify-permit` |

**Local rules** (for demos):

1. Production action + no approvals → **deny**
2. Destructive action (`delete`, `drop`, `destroy`, `truncate`, `purge`, `wipe`, `rm`) + no `change_window` → **hold**
3. Otherwise → **allow** (with a `pt_local_*` permit valid for 5 minutes)

**Environment variables:**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ATLASENT_MODE` | no | auto-detect | Force `local` or `remote` |
| `ATLASENT_API_KEY` | remote only | — | Bearer token for the hosted API |
| `ATLASENT_BASE_URL` | remote only | `https://api.atlasent.com` | Hosted API base URL |
| `ATLASENT_ANON_KEY` | no | — | Optional `x-anon-key` header |

## Claude Desktop config

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "as_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.com"
      }
    }
  }
}
```

Location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## Cursor config

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally), same shape as above.

## Claude Code

```bash
claude mcp add atlasent -- npx -y @atlasent/mcp-server
export ATLASENT_API_KEY=as_live_xxxxxxxxxxxxxxxx
```

## Fail-closed guarantees

Every error path collapses to `{ decision: "deny" }`:

- API unreachable → **deny**
- Request timeout (10s) → **deny**
- Malformed response → **deny**
- Remote returns `allow` without a `permit_token` → **deny**
- Unknown/invalid decision string → **deny**

The agent never proceeds without an explicit `allow`.

## How the hosted backend plugs in later

Nothing in the tool handlers changes when you move from local to remote. The `deploy_service` handler calls `authorize(ctx)`; `authorize()` reads `ATLASENT_MODE` on every call and picks the engine. Switching to the hosted backend is three env vars.

The hosted API contract is already defined in `src/engine.ts` (`authorizeRemote`, `verifyRemote`):

- `POST /v1-evaluate` — body includes `action_type`, `actor_id`, `environment`, `approvals?`, `change_window?`
- `POST /v1-verify-permit` — body includes `permit_token` and the same context

When the hosted backend's decision contract is finalized, the remote adapter is the only file that might need to change. Tool handlers, tests, and the demo all remain identical.

## Development

```bash
npm install
npm run build              # compile TypeScript
npm test                   # 22 unit tests (local + remote mocked)
npm run test:integration   # requires ATLASENT_API_KEY + ATLASENT_BASE_URL; skips otherwise
npm run demo               # end-to-end authorization demo (local mode)
```

## License

[MIT](LICENSE)
