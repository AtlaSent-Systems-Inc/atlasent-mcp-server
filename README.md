# @atlasent/mcp-server

[![npm version](https://img.shields.io/npm/v/@atlasent/mcp-server.svg)](https://www.npmjs.com/package/@atlasent/mcp-server)
[![CI](https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**Authorization for consequential AI-agent actions at the execution boundary.**

AtlaSent performs **execution-time authorization**: determine whether a specific consequential Action is authorized now, issue a bounded Permit on `allow`, verify that Permit at the execution Gate, and only then allow the governed native effect.

> **A plausible request is not organizational authority.**

This MCP server exposes AtlaSent authorization primitives to Model Context Protocol hosts and includes a protected deployment demo that proves the ordering end to end.

## The invariant

For an enforced protected path:

```text
Action proposed
  → current organizational Authority + Policy + Context evaluated
  → Decision
      deny / hold / escalate → STOP
      allow → bounded Permit
  → Permit Verification at the execution Gate
      invalid / expired / replayed / mismatched / error → STOP
      verified → native effect may execute
  → execution/native-effect Evidence recorded where the integration supplies it
```

**Evaluation is not execution. A positive Decision is not the Gate. Permit Verification happens before the protected side effect.**

## Install

```bash
npm install @atlasent/mcp-server
```

Or run the local demo:

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server.git
cd atlasent-mcp-server
npm install
npm run build
npm run demo
```

Local mode is a development/demo convenience. Its in-process policy engine and local Permit format are not a substitute for a deployed, accepted customer enforcement topology.

## Canon-backed Actions

AtlaSent does not treat every ad-hoc tool string as a new governed Action Type.

Use the **Protected Action Canon** for stable Action identity. Two important examples are:

```text
production.deploy
agent.tool.invoke
```

For a generic AI tool invocation, use `agent.tool.invoke` as the public Canon-backed Action Type and carry tool-specific facts—tool name, target, environment, arguments/payload digest, resource state, and other required context—in the authorization context or binding fields supported by the selected integration path.

Use the read-only `atlasent_lookup_action` tool to discover Canon-backed Action Types instead of inventing a parallel taxonomy.

## Authority is not Approval

Keep the concepts separate:

- **Authority** — standing, scoped organizational right to cause a class of change.
- **Authorization** — per-request determination whether this exact Action may proceed now.
- **Policy** — versioned conditions applied to the determination.
- **Approval** — verified input that may satisfy a Policy condition; not standing Authority and not the final Authorization result.
- **Decision** — `allow | deny | hold | escalate` at the platform boundary.
- **Permit** — bounded positive-Authorization artifact.
- **Verification** — execution-boundary check of the Permit and applicable bindings.
- **Execution / native effect** — what the underlying tool or system actually does.
- **Evidence / Proof** — durable evidence of the authorization and, where observed, the effect/result.

A human Approval, favorable risk signal, policy match, deployment ticket, or workflow status does not by itself become organizational Authority.

## Protected-tool demo

`deploy_service` is intentionally small. It demonstrates a two-layer protected path:

```text
agent requests deploy_service
  → authorize internal agent-tool compatibility gate
  → verify outer Permit
  → authorize production.deploy
  → verify production.deploy Permit
  → simulated deployment effect
```

The internal outer gate uses the Canon-backed `agent.tool.invoke` Action (`CANON-000026` / `ACT-0029`) — the same public identifier documented throughout the AtlaSent ecosystem as the canonical generic AI-agent tool invocation. It previously used a legacy, uncatalogued identity, `model.agent.execute_tool`, which had no corresponding `action_classes` provisioning path in the runtime (no seed/migration anywhere creates a row with that slug) — so against a real, unmodified AtlaSent org the outer gate could only ever return `NO_ACTION_CLASS` deny, regardless of the tool-specific inner gate's own decision. Migrating the outer gate onto `agent.tool.invoke` gives it the real "AI Agent Safeguard" provisioning path (`atlasent-api`'s `seed_ai_agent_safeguard_fn.sql` / `provision-agent-pilot-org.sql`) that already exists for exactly this purpose. See AtlaSent-Systems-Inc/atlasent-mcp-server#121 for the full investigation and decision record.

If either Decision is non-allow **or either Permit fails Verification**, no deployment result is produced.

The protected-tool response includes the action-specific Verification result alongside the simulated native result:

```json
{
  "decision": "allow",
  "permit_token": "...",
  "verification": {
    "outcome": "verified",
    "valid": true
  },
  "result": {
    "status": "deployed",
    "service": "billing-api"
  }
}
```

The returned Permit has already been consumed by the execution-boundary Verification. Verifying it again should be treated as a replay, not as a step required after deployment.

## Self-gating agent pattern

For an agent or MCP host that owns its own native tool boundary, the safe pattern is:

```ts
const decision = await evaluate({
  action_type: "agent.tool.invoke",
  actor_id: "agent:research-bot",
  environment: "production",
});

if (decision.decision !== "allow") {
  throw new Error("Action is not authorized");
}

const verification = await verify_permit({
  permit_token: decision.permit_token,
  action_type: "agent.tool.invoke",
  actor_id: "agent:research-bot",
  environment: "production",
  // Present target_id / payload_hash when the selected authorization path
  // binds those fields.
});

if (!verification.valid) {
  throw new Error("Permit did not verify");
}

// Only now may the protected native effect occur.
const result = await runProtectedTool();
```

A wrapper, decorator, prompt, or MCP tool definition is not automatically a non-bypassable Gate. The enforcement claim belongs to the actual topology: the native effect must be unreachable through the claimed protected path unless required Authorization and Permit Verification succeeded.

## Core tools

### `evaluate`

Simple local/remote authorization helper for MCP hosts.

```text
Input:  { action_type, actor_id, environment, approvals?, change_window? }
Output: { decision: "allow" | "deny" | "hold", permit_token?, ... }
```

On `allow`, **do not execute yet**. Present the Permit to `verify_permit` at the execution boundary first.

### `verify_permit`

Execution-boundary verification helper.

```text
Input: {
  permit_token,
  action_type,
  actor_id,
  environment,
  approvals?,
  change_window?,
  target_id?,
  payload_hash?
}
Output: { outcome: "verified" | "expired" | "invalid" | "error", valid, ... }
```

Proceed only when `valid === true`. Successful Verification consumes a single-use Permit where that contract applies.

### `deploy_service`

Protected deployment demonstration. It performs the necessary Authorization and Verification internally before producing its simulated deployment result.

### `atlasent_evaluate` / `atlasent_verify_permit`

Hosted V1 API-facing tools. Use the richer remote evaluation path when you need additional context beyond the small `evaluate` demo envelope. Verification remains an execution-boundary operation.

### `atlasent_lookup_action`

Read-only Canon lookup for Action Types, gate flags, authorization patterns, evidence requirements, and graph relationships.

### `atlasent_atlas_lookup`

Read-only lookup of canonical AtlaSent concepts such as Authority, Policy, Decision, Permit, Verification, Evidence, Gate, and Trust Root.

### `atlasent_integrity_audit`

Read-only audit of the organization's Authority graph for internal inconsistency. Hosted mode only; the organization is derived server-side from the API key.

```text
Input:  { decision_window_days? }   // 1-3650; omit to let the server choose
Output: the integrity report, verbatim
```

**This is not a pass/fail health check, and the tool adds no verdict of its own.** Each finding carries a three-way `classification`:

| `classification` | How to read it |
|---|---|
| `defect` | A genuine inconsistency in the Authority graph. |
| `non_exercisable` | Frequently the **correct, healthy** state — e.g. an expired grant that is supposed to be expired. Not a failure. |
| `unresolved` | The proposition **could not be verified**. Never treat it as clean; "could not check" and "checked and found nothing" are different facts. |

Read `summary.audited_scope` before concluding anything from an empty `findings` list — a short decision window is not an absence of findings. If the audit cannot complete, the server refuses rather than returning a partial report, and this tool surfaces that as an error rather than an empty report.

The server also exposes policy, permit, approval, evidence, compliance, trajectory, and VQP tools. Use MCP `tools/list` for the exact tool inventory supported by the installed version.

## Approval workflow

Approval can be required, but resolving an Approval is not equivalent to executing the protected Action.

```text
Approval / Assertion collected
  → current Authorization / reevaluation path
  → Decision
  → Permit on allow
  → Verification
  → native effect
```

Use `atlasent_create_approval_request` and `atlasent_resolve_approval_request` to manage approval inputs. The protected Action must still satisfy the current authorization path and execution-boundary Verification before proceeding.

## Execution evidence

`atlasent_record_execution_evaluation` records an observed execution outcome after the native effect. That evidence function does **not** replace pre-execution Permit Verification.

Keep these statements distinct:

- an `allow` Decision proves a positive authorization determination was made;
- a verified Permit proves the bounded authorization artifact passed its Gate checks at that point in time;
- execution/native-effect evidence is what supports a claim that the underlying action actually occurred.

## Local vs remote mode

| Mode | Purpose |
|---|---|
| `local` | Development/demo/CI using the small in-process rules engine. |
| `remote` | Calls the configured AtlaSent hosted/runtime API. |

Remote example:

```bash
ATLASENT_MODE=remote \
ATLASENT_API_KEY=ask_live_xxx \
ATLASENT_BASE_URL=https://api.atlasent.io/functions/v1 \
ATLASENT_MCP_READONLY=1 \
npx @atlasent/mcp-server
```

`ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1` — this is the
correct base for the core `evaluate` / `verify_permit` / `atlasent_evaluate` path and
for other dash-form direct endpoints (`/v1-evaluate`, `/v1-verify-permit`,
`/v1-authority-intelligence/...`). The generic REST tools (policies, permits, audit
events, webhooks, SCIM, SIEM, evidence exports, approval requests) are served at the
gateway/API domain root under slash-form paths (`/v1/policies`, `/v1/permits`, ...);
the server automatically strips the `/functions/v1` suffix for those calls, so a
single `ATLASENT_BASE_URL` value works for both families — no separate configuration
needed.

## Read-only mode for live demos

Set:

```bash
ATLASENT_MCP_READONLY=1
```

to prevent registration of mutating administrative tools during a live-API demo. Read-only mode does not turn the server into a universal security boundary; it reduces the exposed mutation surface. The protected execution path still depends on the Authorization and Verification topology described above.

## Fail-closed behavior

For a path that is configured to require AtlaSent Authorization and Permit Verification, treat these as block conditions:

- non-allow Decision;
- missing required Permit;
- authentication/API failure;
- invalid, expired, revoked, replayed, or binding-mismatched Permit;
- Verification error;
- missing required execution binding.

Shadow/advisory evaluation is useful for observation, but it is not the same as enforced execution protection.

## Claude Desktop

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.io/functions/v1",
        "ATLASENT_MCP_READONLY": "1"
      }
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.io/functions/v1",
        "ATLASENT_MCP_READONLY": "1"
      }
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.io/functions/v1",
        "ATLASENT_MCP_READONLY": "1"
      }
    }
  }
}
```

## Other MCP clients

The same server can be configured in any other MCP-compatible host using its normal MCP server configuration mechanism (`command: npx`, `args: ["-y", "@atlasent/mcp-server"]`, and the same `env` block shown above).

This server is also distributed via the [official MCP Registry](https://registry.modelcontextprotocol.io) (`io.github.atlasent-systems-inc/mcp-server`, manifest at [`server.json`](./server.json)) and [Smithery](https://smithery.ai) (config at [`smithery.yaml`](./smithery.yaml)) — a registry- or Smithery-aware host can discover and install it without a hand-written config block.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run demo
```

`npm test` includes regression tests proving that the protected deployment demo does not produce a native result when either the outer agent-tool Permit or the action-specific deployment Permit fails Verification.

## Security

Do not place API keys, signing material, customer secrets, or production credentials in source control. Limit authorization context to facts required by the selected policy and bindings.

Security-sensitive integrations must place the actual side effect **after** the required Authorization and Verification checks in control flow. Logging a Decision and then executing anyway is not enforcement.

## Related public components

- [`atlasent-sdk`](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk) — language SDKs
- [`atlasent-action`](https://github.com/AtlaSent-Systems-Inc/atlasent-action) — GitHub Actions integration
- [`atlasent-verify`](https://github.com/AtlaSent-Systems-Inc/atlasent-verify) — offline evidence verifier
- [`atlasent-keys`](https://github.com/AtlaSent-Systems-Inc/atlasent-keys) — public verification material

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
