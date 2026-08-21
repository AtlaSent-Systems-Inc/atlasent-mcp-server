# @atlasent/mcp-server

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

For a generic AI tool invocation, use `agent.tool.invoke` as the Action Type and carry tool-specific facts—tool name, target, environment, arguments/payload digest, resource state, and other required context—in the authorization context or binding fields supported by the selected integration path.

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
  → authorize agent.tool.invoke
  → verify agent-tool Permit
  → authorize production.deploy
  → verify production.deploy Permit
  → simulated deployment effect
```

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

`ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1`.

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

The same server can be configured in other MCP-compatible hosts using their normal MCP server configuration mechanism.

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
