# @atlasent/mcp-server

**AtlaSent is the authorization boundary for AI agents.**

This MCP server governs *whether* an agent's tool calls may run — before they do. MCP exposes the tools (`send_email`, `access_sensitive_dataset`, `write_to_production`, ...); AtlaSent decides whether each call is allowed, held for review, or denied. A blocked call never touches the target system.

The repo ships with a local rules engine so you can see the full block/allow flow in under a minute, with zero credentials. The hosted AtlaSent backend is a configuration swap, not a rewrite.

## MCP vs. AtlaSent

MCP is the pipe. AtlaSent is the gate.

| Concern | Owned by |
|---|---|
| Exposing tools to the agent | **MCP** (`tools/list`) |
| Shaping the tool request | **MCP** (input schemas) |
| Deciding if the tool may run | **AtlaSent** (`authorize()`) |
| Executing the tool | The tool author |
| Closing the audit loop | **AtlaSent** (`verify_permit`) |

Every protected tool in this server follows the same pattern — `authorize()` runs before the action. If the decision is not `allow`, the action code never runs.

## Run the demo in 60 seconds

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server.git
cd atlasent-mcp-server
npm install
npm run demo
```

You'll see seven scenarios run end-to-end:

```
1. send_email (external)          → BLOCKED BY ATLASENT
2. send_email (internal)          → ALLOWED
3. access_sensitive_dataset (PII) → BLOCKED BY ATLASENT
4. access_sensitive_dataset (pub) → ALLOWED
5. write_to_production (no appr)  → BLOCKED BY ATLASENT
6. write_to_production (approval) → ALLOWED
7. verify_permit                  → verified (audit loop closed)
```

The demo uses `local` mode (no API key). To run against the hosted AtlaSent backend:

```bash
ATLASENT_MODE=remote \
  ATLASENT_API_KEY=as_live_xxx \
  ATLASENT_BASE_URL=https://api.atlasent.com \
  npm run demo
```

## Blocked tool call — minimal walkthrough

Here's a single round-trip for scenario 1 above. The agent asks MCP to send an email to an external domain; AtlaSent blocks it before SMTP is ever touched.

**1. Agent → MCP**

```json
{
  "method": "tools/call",
  "params": {
    "name": "send_email",
    "arguments": {
      "to": "ceo@competitor.com",
      "subject": "Proposal",
      "body": "Draft proposal attached.",
      "actor_id": "agent-copilot-7"
    }
  }
}
```

**2. Inside the tool handler** (`src/server.ts`)

```ts
const ctx: ActionContext = {
  action_type: "send_email",
  actor_id: args.actor_id,
  environment: "default",
  context: { recipient: args.to, external: true, subject: args.subject },
};

const decision = await authorize(ctx);           // ← INTERCEPTION POINT

if (decision.decision !== "allow") {
  return toolResult(decision);                   // blocked; SMTP never runs
}

// (never reached for this request)
const sent = await smtp.send(...);
return toolResult(decision, { result: sent });
```

**3. MCP → Agent**

```
content[0] = "[BLOCKED BY ATLASENT] Action 'send_email' is external and
              requires at least one approval. — tool did NOT execute."
content[1] = {
  "decision": "deny",
  "reason": "Action 'send_email' is external and requires at least one approval.",
  "audit_id": "aud_local_mo9nxvgc_88nq2z"
}
isError    = true
```

The agent sees a clearly labeled block and a structured payload. The SMTP server was never contacted. Compare to a tool that ran and failed — that comes back with `[TOOL EXECUTION FAILED] ...` and no `decision` field. The two are impossible to confuse.

## Tools exposed

### AtlaSent primitives

| Tool | Purpose |
|---|---|
| `evaluate` | Ask for a decision. Agents that gate themselves call this before any sensitive action. |
| `verify_permit` | Confirm a previously issued permit. Called after the action runs to close the audit loop. |

### Protected demo tools

Each one calls `authorize()` before touching anything, and each one demonstrates a different blocking signal:

| Tool | Block signal | Demo scenario |
|---|---|---|
| `send_email` | `context.external === true` + no approval | blocks external recipients |
| `access_sensitive_dataset` | `context.sensitivity === "pii" \| "phi" \| ...` + no approval | blocks PII / PHI reads |
| `write_to_production` | `environment === "production"` + no approval | blocks prod writes |
| `deploy_service` | same as `write_to_production` (kept for back-compat) | blocks prod deploys |

In production, your domain tools live on other MCP servers and call AtlaSent's `evaluate` tool themselves. This repo co-locates them so the full flow is visible in one process.

## The interception pattern

Every protected tool handler is ~20 lines of the same shape:

```ts
const ctx: ActionContext = {
  action_type: "<what the agent is doing>",
  actor_id:    "<who is acting>",
  environment: "<prod | staging | default>",
  approvals:   args.approvals,
  context:     { /* tool-specific attributes the policy may inspect */ },
};

// ─── INTERCEPTION POINT ──────────────────────────────
const decision = await authorize(ctx);
if (decision.decision !== "allow") {
  return toolResult(decision);   // BLOCKED → action code never runs
}
// ─────────────────────────────────────────────────────

const result = /* run the action */;
return toolResult(decision, { result });
```

That's the whole guarantee. The interception is the authorization check before the action. Nothing downstream can mis-order it because the action code is literally after the `if` block.

## Decision envelope

Every `authorize()` result uses the same JSON shape:

```ts
type Decision =
  | { decision: "allow";  permit_token: string; audit_id?: string; conditions?: string[] }
  | { decision: "deny";   reason: string;       audit_id?: string }
  | { decision: "hold";   reason: string;       hold_id?: string; audit_id?: string };
```

Verification parallels:

```ts
type VerifyResult = {
  outcome: "verified" | "expired" | "invalid" | "error";
  valid: boolean;
  reason?: string;
  audit_id?: string;
};
```

**Agent behavior:**

| Decision | Behavior |
|---|---|
| `allow` | Proceed. Pass `permit_token` to `verify_permit` after completing the action. |
| `deny` | Do not proceed. Surface `reason` to the user. |
| `hold` | Do not proceed. Tell the user the action is queued for human review; reference `hold_id`. |
| verification failure | Flag the action for review — something happened outside policy. |

**Block vs. tool failure.** MCP hosts get two content blocks per tool call: a banner and a structured payload. The banner makes the distinction unmistakable:

- `[ALLOWED BY ATLASENT] ...` — action was authorized and ran.
- `[BLOCKED BY ATLASENT] ...` — authorization denied; the tool code did not execute.
- `[HELD BY ATLASENT] ...` — awaiting human review; the tool code did not execute.
- `[TOOL EXECUTION FAILED] ...` — authorization passed, but the action threw while running.
- `[PERMIT VERIFIED] ...` / `[PERMIT NOT VERIFIED] ...` — audit-loop closure.

## Canonical payload (`ActionContext`)

```ts
type ActionContext = {
  action_type:    string;                     // what the agent wants to do
  actor_id:       string;                     // who is acting
  environment:    string;                     // target environment
  approvals?:     string[];                   // attached approvals (ticket IDs, reviewers)
  change_window?: string;                     // ISO-8601 window, if scheduled
  context?:       Record<string, unknown>;    // tool-specific attributes for the policy
};
```

`context` is the extensibility point. Put everything the policy needs — recipient, dataset classification, payload preview — in there. AtlaSent policies inspect it; the MCP tool doesn't have to know the rules.

## Local vs. Remote mode

The engine behind `authorize()` is pluggable. Tool handlers don't change — swapping the backend is configuration.

| Mode | When selected | What it does |
|---|---|---|
| `local` | `ATLASENT_MODE=local`, or neither `ATLASENT_API_KEY` nor `ATLASENT_BASE_URL` is set | In-process rules engine (`src/localEngine.ts`). No network. |
| `remote` | `ATLASENT_MODE=remote`, or both `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` are set | Hosted backend: `POST /v1-evaluate`, `POST /v1-verify-permit`. |

**Local rules** (for demos):

1. `environment === "production"` + no approvals → **deny**
2. Destructive action (`delete`, `drop`, `destroy`, `truncate`, `purge`, `wipe`, `rm`) + no `change_window` → **hold**
3. `context.sensitivity in {"pii", "phi", "high", "restricted", "secret"}` + no approvals → **deny**
4. `context.external === true` + no approvals → **deny**
5. Otherwise → **allow** (5-minute permit)

**Environment variables:**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ATLASENT_MODE` | no | auto-detect | Force `local` or `remote` |
| `ATLASENT_API_KEY` | remote only | — | Bearer token for the hosted API |
| `ATLASENT_BASE_URL` | remote only | `https://api.atlasent.com` | Hosted API base URL |
| `ATLASENT_ANON_KEY` | no | — | Optional `x-anon-key` header |
| `ATLASENT_TRANSPORT` | no | `stdio` | Set to `http` to bind over HTTP (see `src/http-transport.ts`) |

## Fail-closed guarantees

Every error path collapses to `{ decision: "deny" }`:

- API unreachable → **deny**
- Request timeout (10s) → **deny**
- Malformed response → **deny**
- Remote returns `allow` without a `permit_token` → **deny**
- Unknown / invalid decision string → **deny**

The agent never proceeds without an explicit `allow`.

## Claude Desktop / Cursor / Claude Code config

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

Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
Cursor: `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json`).
Claude Code:

```bash
claude mcp add atlasent -- npx -y @atlasent/mcp-server
export ATLASENT_API_KEY=as_live_xxxxxxxxxxxxxxxx
```

## Development

```bash
npm install
npm run build              # compile TypeScript
npm test                   # unit tests (local + remote mocked)
npm run test:integration   # requires ATLASENT_API_KEY + ATLASENT_BASE_URL; skips otherwise
npm run demo               # end-to-end authorization demo (local mode)
```

## License

[MIT](LICENSE)
