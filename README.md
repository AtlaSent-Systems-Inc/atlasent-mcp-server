# @atlasent/mcp-server

**Authorize every AI agent tool call before it executes.**

An MCP server that plugs into any [Model Context Protocol](https://modelcontextprotocol.io)-compatible agent (Claude Desktop, Cursor, Claude Code, Copilot, LangChain) and enforces a simple contract: *no protected action runs until AtlaSent has authorized it*. Denied calls never reach the target system. Allowed calls return a permit token you can verify afterwards to close the audit loop.

Ships with a local rules engine so you can run the full evaluate → act → verify flow in under a minute, with zero credentials. The hosted AtlaSent backend is a configuration swap, not a rewrite.

## The evaluate → permit → verify pattern

Every protected tool call follows three steps:

```
1. evaluate   ——  atlasent_evaluate(action, subject, resource)
                 → decision: allow | deny | hold | escalate
                 → permit_token (only on allow)

2. execute    ——  your action runs (only if decision === "allow")

3. verify     ——  atlasent_verify_permit(permit_token)
                 → closes the audit loop
                 → marks permit consumed (single-use)
```

If `decision !== "allow"` at step 1, execution never reaches step 2. If the AtlaSent API is unreachable, step 1 fails closed — `deny` — and execution is blocked.

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
        ✓ reason: Production action 'production.deploy' requires at least one approval...

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
  ATLASENT_API_KEY=ask_live_xxx \
  ATLASENT_BASE_URL=https://api.atlasent.com \
  ATLASENT_MCP_READONLY=1 \
  npm run demo
```

`ATLASENT_MCP_READONLY=1` is **recommended for any live-API demo** — see [Read-only mode](#read-only-mode-for-live-demos) below.

## Tools

### `atlasent_evaluate` — evaluate an action against AtlaSent policies

Evaluate whether a subject is permitted to perform an action on a resource. Returns a `decision` (`allow`/`deny`/`hold`/`escalate`), a `permit_token` if allowed, an `evaluation_id`, and an optional `reason`.

```
Input:  { subject, action, resource, org_id, context? }
Output: { decision, permit_token?, evaluation_id?, reason?, ... }
```

**Example:**
```json
{
  "subject": "user:alice",
  "action": "production.deploy",
  "resource": "env:prod",
  "org_id": "org_abc123",
  "context": { "ip": "10.0.0.1" }
}
```

### `atlasent_list_policies` — list all policies for an organization

Returns all policies for the given org, optionally filtered by status.

```
Input:  { org_id, status? }   (status: "draft" | "shadow" | "enforce")
Output: array of policy objects
```

**Example:** `{ "org_id": "org_abc123", "status": "enforce" }`

### `atlasent_get_policy` — get a single policy by ID

Fetches the full policy definition for a given `policy_id`.

```
Input:  { policy_id, org_id }
Output: policy object
```

**Example:** `{ "policy_id": "pol_xyz789", "org_id": "org_abc123" }`

### `atlasent_list_audit_events` — query the audit event log

Query recent evaluation decisions. Use to verify that an evaluation was recorded or to investigate a sequence of decisions.

```
Input:  { org_id, evaluation_id?, from?, to?, limit? }
        (from/to: ISO 8601; limit: 1–100, default 20)
Output: array of audit event objects
```

**Example:**
```json
{
  "org_id": "org_abc123",
  "from": "2025-01-01T00:00:00Z",
  "to": "2025-01-02T00:00:00Z",
  "limit": 50
}
```

### `atlasent_create_policy` — create an authorization policy

> **Mutating tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Define a new authorization rule. New policies are created in `draft` state (no enforcement) and must be promoted to `shadow` or `enforce` to take effect.

```
Input:  { org_id, policy_id, title, policy_type, rules, description?, status?, ... }
Output: { policy_id, title, status, ... }
```

### `atlasent_update_policy` — update an existing policy

> **Mutating tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Partial-update (PATCH) a policy's rules, metadata, or lifecycle status (e.g. promote `draft` → `enforce`).

```
Input:  { policy_id, org_id, title?, rules?, status?, ... }
Output: { policy_id, status, ... }
```

### `atlasent_delete_policy` — permanently delete a policy

> **Destructive tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Irreversibly remove a policy. Prefer setting `status: "archived"` via `atlasent_update_policy` when you only want to disable enforcement.

```
Input:  { policy_id, org_id }
Output: {} (empty on success)
```

### `atlasent_list_permits` — list issued permits

Paginated list of permits for an organization, with optional filters by status, actor, action type, and time range.

```
Input:  { org_id, status?, actor_id?, action_type?, from?, to?, limit?, cursor? }
Output: { permits: [...], next_cursor? }
```

### `atlasent_revoke_permit` — revoke an issued permit

> **Destructive tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Immediately invalidate a permit so subsequent verify calls fail with `permit_revoked`. Idempotent.

```
Input:  { permit_id, org_id, reason? }
Output: { revoked, permit_id, ... }
```

### `atlasent_permit` — issue a permit token out-of-band

> **Mutating tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Mint a time-limited permit for a subject/action/resource outside of the standard evaluate flow — for example when a human pre-approves access.

```
Input:  { subject, action, resource, org_id, ttl_seconds?, context? }
Output: { permit_token, expires_at?, ... }
```

### `atlasent_verify_permit` — verify a permit token (v1 REST)

Verify a permit token is currently valid for a given subject/action/resource. Use after completing an authorized action to close the audit loop.

```
Input:  { permit_token, org_id, action?, resource? }
Output: { valid, outcome, reason? }
```

### `atlasent_create_approval_request` — request human approval

Submit an action for human sign-off. Call when `atlasent_evaluate` returns `hold` or when the agent knows approval is required. Do not proceed until resolved.

```
Input:  { subject, action, resource, org_id, justification?, context? }
Output: { approval_request_id, status, created_at, ... }
```

### `atlasent_resolve_approval_request` — approve or deny a request

Approve or deny a pending approval request on behalf of a human reviewer.

```
Input:  { approval_request_id, org_id, resolution, resolver_id, comment? }
        (resolution: "approve" | "deny")
Output: { approval_request_id, status, resolver_id, ... }
```

### `atlasent_record_execution_evaluation` — record execution outcome

Record the outcome of an authorized action to complete the full audit loop: evaluate → execute → record.

```
Input:  { evaluation_id, org_id, outcome, executed_at?, details? }
        (outcome: "success" | "failure" | "skipped")
Output: { execution_id, outcome, recorded_at, ... }
```

### `atlasent_create_webhook` — register a webhook

> **Mutating tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Subscribe an external HTTPS endpoint to real-time AtlaSent events (e.g. `evaluation.deny`, `approval.requested`, `permit.revoked`).

```
Input:  { org_id, url, events, description?, secret? }
Output: { webhook_id, url, events, secret?, ... }
```

### `atlasent_delete_webhook` — remove a webhook

> **Destructive tool — gated off when `ATLASENT_MCP_READONLY=1`.**

Permanently deregister a webhook. AtlaSent stops sending events to that URL immediately.

```
Input:  { webhook_id, org_id }
Output: {} (empty on success)
```

### `evaluate` — for agents that gate themselves (local/remote mode)

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

See `src/server.ts` (the `deploy_service` handler) for the exact 20-line pattern every protected tool should follow.

## Execution Flow

```
  ┌─────────────┐
  │    Agent     │  wants to call a protected tool
  └─────┬───────┘
        │
        ▼
  ┌───────────────────────┐
  │    Protected tool       │
  │  (e.g. deploy_service)  │
  └─────┬─────────────────┘
        │ (1) build ActionContext
        ▼
  ┌─────────────────┐       ┌──────────────────────────┐
  │  authorize(ctx)  │──────▶│  engine (local | remote)  │
  └─────┬───────────┘       └────────┬─────────────────┘
        │ (2) Decision               │
        │   allow | deny | hold      │
        ▼                            ▼
  ┌────────────────────────────────────┐
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

The **interception point** is step (2): `authorize()` runs before the action. If `decision !== "allow"`, the action does not run.

## Decision envelope

Every authorization result uses the same shape:

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
|----------|-----------------|
| `allow` | Proceed. Pass `permit_token` to `verify_permit` after completing the action. |
| `deny` | Do not proceed. Surface `reason` to the user. |
| `hold` | Do not proceed. Tell the user the action is queued for human review; reference `hold_id`. |
| **verification failure** (`valid: false` or `outcome: "error"`) | Flag the action for review. |

## Local vs Remote mode

The engine behind `authorize()` is pluggable. The same tool handlers work in both modes — swapping the backend is a configuration change.

| Mode | When selected | What it does |
|------|---------------|--------------|
| `local` | `ATLASENT_MODE=local`, or both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are unset | Runs a small in-process rules engine (`src/localEngine.ts`) — no network, no credentials |
| `remote` | `ATLASENT_MODE=remote`, or both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are set | Calls the hosted AtlaSent backend at `POST /v1-evaluate` and `POST /v1-verify-permit` |

**Local rules** (for demos):

1. Production action + no approvals → **deny**
2. Destructive action (`delete`, `drop`, `destroy`, `truncate`, `purge`, `wipe`, `rm`) + no `change_window` → **hold**
3. Otherwise → **allow** (with a `pt_local_*` permit valid for 5 minutes)

**Environment variables:**

| Variable | Required | Default | Purpose |
|----------|----------|---------|----------|
| `ATLASENT_MODE` | no | auto-detect | Force `local` or `remote` |
| `ATLASENT_API_KEY` | remote only | — | Bearer token for the hosted API |
| `ATLASENT_BASE_URL` | remote only | `https://api.atlasent.com` | Hosted API base URL |
| `ATLASENT_ANON_KEY` | no | — | Optional `x-anon-key` header |
| `ATLASENT_MCP_RATE_LIMIT` | no | `600` | Per-tool calls per minute (token bucket) |
| `ATLASENT_MCP_READONLY` | no | (unset) | If `1` or `true`, skip registration of the 7 mutating tools. **Recommended for live-API demos.** |

## Read-only mode (for live demos)

Set `ATLASENT_MCP_READONLY=1` and the server skips registration of these 7 mutating tools at startup:

- `atlasent_create_policy`
- `atlasent_update_policy`
- `atlasent_delete_policy`
- `atlasent_create_webhook`
- `atlasent_delete_webhook`
- `atlasent_revoke_permit`
- `atlasent_permit`

Everything else stays available, including the full demo flow (evaluate → act → verify), all read tools, and the approval-request workflow.

On startup, the server emits a `server.readonly_mode` structured log line to stderr listing the disabled tools.

**When to enable:** any live demo (customer call, conference, screencast) that uses a real API key — even on a dedicated demo org. Disable only when intentionally exercising the mutating tools from a trusted operator console.

## Claude Desktop config

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.com",
        "ATLASENT_MCP_READONLY": "1"
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
export ATLASENT_API_KEY=ask_live_xxxxxxxxxxxxxxxx
export ATLASENT_MCP_READONLY=1   # safe default; unset for ops sessions
```

## Fail-closed guarantees

Every error path collapses to `{ decision: "deny" }`:

- API unreachable → **deny**
- Request timeout (10s) → **deny**
- Malformed response → **deny**
- Remote returns `allow` without a `permit_token` → **deny**
- Unknown/invalid decision string → **deny**
- Verify returns an unrecognized `verify_error_code` → **invalid** (treated as not valid)

The agent never proceeds without an explicit `allow`.

## How the hosted backend plugs in

The remote adapter (`src/engine.ts`) speaks the AtlaSent API edge-function shape directly:

- `POST /v1-evaluate` — request: `{ action_type, actor_id, context }`. Response: `{ decision, permit_token?, request_id, expires_at?, denial?, ... }`
- `POST /v1-verify-permit` — request: `{ permit_token, action_type, actor_id }`. Response: `{ valid, outcome, verify_error_code?, reason? }`

Both endpoints are served by `atlasent-api`.

## Development

```bash
npm install
npm run build              # compile TypeScript
npm test                   # 26 unit tests (local + remote mocked) + readonly-mode tests
npm run test:integration   # requires ATLASENT_API_KEY + ATLASENT_BASE_URL; skips otherwise
npm run demo               # end-to-end authorization demo (local mode)
```

## License

[MIT](LICENSE)
