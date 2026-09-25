# @atlasent/mcp-server

MCP server that enforces authorize-before-execute for any MCP-compatible AI agent.

[![npm version](https://img.shields.io/npm/v/@atlasent/mcp-server.svg)](https://www.npmjs.com/package/@atlasent/mcp-server)
[![CI](https://github.com/Atlasent/atlasent-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Atlasent/atlasent-mcp-server/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Glama MCP server](https://glama.ai/mcp/servers/Atlasent/atlasent-mcp-server/badge)](https://glama.ai/mcp/servers/Atlasent/atlasent-mcp-server)

**Authorization for consequential AI-agent actions at the execution boundary.**

AtlaSent performs **execution-time authorization**: determine whether a specific consequential Action is authorized now, issue a bounded Permit on `allow`, verify that Permit at the execution Gate, and only then allow the governed native effect.

> **A plausible request is not organizational authority.**

This MCP server exposes AtlaSent authorization primitives to Model Context Protocol hosts and includes a protected deployment demo that proves the ordering end to end.

## Which authority decided?

This repository ships **two packages**, and one of them has two modes. All three block
tool calls. Only one of the three is evidence, and the difference is not a feature list —
it is *who said yes*.

| Surface | Who decided | What it is |
|---|---|---|
| `@atlasent/mcp-server` **local mode** | a built-in heuristic | **nothing** — a credential-free demo. Its terminal rule is `allow`, including for action types it does not recognise. Never rely on it as protection. |
| [`@atlasent/mcp-gate`](./packages/mcp-gate) + `policy.json` | **you**, in advance, in a file you can edit | **operator configuration.** Starts at `{"default":"deny","rules":[]}` and blocks everything until you write a rule. Runs with no account and no network. |
| `@atlasent/mcp-gate` **cloud mode** | **your organization**, at execution time | an **organizational permit** — single-use, bound to that call, verifiable afterwards. |

A rule you can silently edit is configuration. A permit your organization issued, that was
consumed once and can be produced later, is authority. Both stop the call; only the second
answers *"who authorized this?"* — which is the question that arrives after an incident,
not before one.

The gate says which one decided, on every decision: `no_matching_rule` is your local
policy, `cloud_permit_consumed` is an organizational permit. **These reason strings are
deliberately not normalised into a generic "blocked."** Do not collapse them.

The two packages point in opposite directions, which is why they are separate:
`mcp-server` exposes AtlaSent *as* MCP tools an agent calls to ask for authorization;
`mcp-gate` sits *in front of* someone else's MCP server and intercepts.

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

## Quickstart: 60 seconds, no account

You don't need an AtlaSent account or API key to try this server. With no credentials set, it runs in **local mode**: an in-process rules engine that works offline.

Add this to your MCP host config (Claude Desktop, Cursor, Windsurf, and others; per-host file locations are [below](#claude-desktop)):

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_MODE": "local" }
    }
  }
}
```

Then ask your agent to *"deploy billing-api to production"*. The built-in rules deny it because it has no approvals. Ask again with an approval and it's allowed, and the server verifies the permit before the simulated deploy runs.

Built-in local rules (`src/localEngine.ts`):

| Situation | Decision |
|---|---|
| Production action with no approvals | `deny` |
| Destructive action (`delete`, `drop`, `purge`, ...) outside a change window | `hold` |
| Sign / certify / grant / revoke / suspend / resume actions | `deny` |
| Override / release / export / import / publish actions | `hold` |
| Anything that passes the rules | `allow` → single-use permit, 5-minute TTL |

Local permits are **unsigned**, so local mode is for development, CI, and trying things out. It's not a production enforcement boundary. The server refuses to fall back to local mode under `NODE_ENV=production`. When you're ready for signed permits, audit evidence, and your organization's own policies, switch to [remote mode](#local-vs-remote-mode) — [get an API key](#get-an-api-key).

### Run from source

```bash
git clone https://github.com/Atlasent/atlasent-mcp-server.git
cd atlasent-mcp-server
npm install
npm run build
npm run demo      # blocked deploy → approved + verified deploy → replay refused, fully offline
```

### Run with Docker

```bash
docker build -t atlasent-mcp .
docker run -i --rm atlasent-mcp                                          # local mode, stdio
docker run -i --rm -e ATLASENT_API_KEY -e ATLASENT_BASE_URL atlasent-mcp  # remote mode
```

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

The internal outer gate uses the Canon-backed `agent.tool.invoke` Action (`CANON-000026` / `ACT-0029`) — the same public identifier documented throughout the AtlaSent ecosystem as the canonical generic AI-agent tool invocation. It previously used a legacy, uncatalogued identity, `model.agent.execute_tool`, which had no corresponding `action_classes` provisioning path in the runtime (no seed/migration anywhere creates a row with that slug) — so against a real, unmodified AtlaSent org the outer gate could only ever return `NO_ACTION_CLASS` deny, regardless of the tool-specific inner gate's own decision. Migrating the outer gate onto `agent.tool.invoke` gives it the real "AI Agent Safeguard" provisioning path (`atlasent-api`'s `seed_ai_agent_safeguard_fn.sql` / `provision-agent-pilot-org.sql`) that already exists for exactly this purpose. See Atlasent/atlasent-mcp-server#121 for the full investigation and decision record.

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

```text
Input:  { slug? }    // exact Canon slug, e.g. "production.deploy"
        { query? }   // plain language, e.g. "deploy the api service to prod"
        {}           // list the full Canon
Output: { found, result_count, actions[], retrieval? }
```

`query` is resolved by a deterministic, fully offline ranker over the vendored Canon (no embeddings service, no network — `src/actionRetrieval.ts`). The response carries a `retrieval` block:

| `retrieval.confidence` | Meaning |
|---|---|
| `confident` | One Canon entry clearly matches. `actions[0]` is it. Safe to act on. |
| `ambiguous` | Two or more entries are close, or the request only partly matched. Read `retrieval.candidates` and pick, or rephrase. |
| `none` | The Canon has no action matching this description. `found` is `false`, `actions` is empty, and `hint` points at the Canon intake pipeline. |

The tool never invents an action type: every candidate is a Canon entry by reference, and a request the Canon cannot answer comes back as `none` rather than a plausible-looking slug. Context words such as *emergency*, *weekend*, or *urgent* are treated as policy context, not as evidence of a different action — "emergency deploy to production" still resolves to `production.deploy`, per `LIFECYCLE.md`'s classification principle.

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

### `atlasent_get_permit` / `atlasent_check_permit` / `atlasent_get_decision`

Read-only lookups of a single record. Hosted mode only.

```text
atlasent_get_permit    { permit_id }                     -> the permit record (status, actor, action, times, decision_id)
atlasent_check_permit  { permit_id }                     -> { valid, status: active|revoked|consumed|expired, revoked_at? }
atlasent_get_decision  { evaluation_id, include_trace? } -> { evaluation, trace?: { approvals, permit_uses, webhooks } }
```

`atlasent_check_permit` reads status without consuming the permit. Use it before a deferred action to catch a revocation, but it is **not** authorization: execute only after `atlasent_verify_permit`. `atlasent_get_decision` requires the `audit:read` scope; a permit's `decision_id` is the id to pass.

Permit tools never return the permit's `token` (its bearer credential) or `signature`. Anything a tool returns lands in the agent's context and transcript, so both fields are stripped client-side as well as by the API.

The server also exposes policy, permit, approval, evidence, compliance, and VQP tools. Use MCP `tools/list` for the exact tool inventory supported by the installed version.

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
| `local` | Zero-config: offline in-process rules engine, unsigned permits. Development, demos, CI. |
| `remote` | Calls the configured AtlaSent hosted/runtime API. |

### Get an API key

1. Create an account at
   **[console.atlasent.io/auth/sign-up](https://console.atlasent.io/auth/sign-up?utm_source=mcp&utm_medium=readme)**.
2. In the console, open **API keys** and create a key with the `evaluate:write`
   and `verify:execute` scopes.
3. Set `ATLASENT_API_KEY` (and optionally `ATLASENT_BASE_URL`) in your MCP host
   config, as in the example below. The server switches to remote mode
   automatically when both are set.

Remote mode gives you what local mode cannot: Ed25519-signed, single-use permits,
your organization's own policies, and a tamper-evident audit trail you can verify
offline.

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

This server is also listed on [Glama](https://glama.ai/mcp/servers/Atlasent/atlasent-mcp-server) (built from this repo's [`Dockerfile`](./Dockerfile); listing ownership in [`glama.json`](./glama.json)) and distributed via the [official MCP Registry](https://registry.modelcontextprotocol.io) (`io.github.Atlasent/mcp-server`, manifest at [`server.json`](./server.json)) and [Smithery](https://smithery.ai) (config at [`smithery.yaml`](./smithery.yaml)) — a registry-aware host can discover and install it without a hand-written config block.

## Development

```bash
npm install
npm run typecheck
npm test          # offline: no network, no API key
npm run build
npm run demo
```

`npm test` runs entirely offline. Local-mode tests touch no network, and remote-mode tests mock `fetch`. It includes regression tests proving that the protected deployment demo produces no native result when either the outer agent-tool Permit or the action-specific deployment Permit fails Verification.

Prefer a ready-made environment? Open the repo in a [dev container](./.devcontainer/devcontainer.json) (VS Code, or GitHub Codespaces), and it installs and builds on create.

## Community

- **Questions and ideas:** [GitHub Discussions](https://github.com/Atlasent/atlasent-mcp-server/discussions)
- **Bugs and small features:** [open an issue](https://github.com/Atlasent/atlasent-mcp-server/issues/new/choose)
- **Bigger changes** (new tools, wire-shape or fail-closed behavior): start with an [RFC issue](https://github.com/Atlasent/atlasent-mcp-server/issues/new?template=rfc.md)
- **Want to contribute?** Read [CONTRIBUTING.md](./CONTRIBUTING.md) and look for [`good first issue`](https://github.com/Atlasent/atlasent-mcp-server/labels/good%20first%20issue)
- **Security reports:** email security@atlasent.io. See [SECURITY.md](./SECURITY.md). Please don't open a public issue.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Do not place API keys, signing material, customer secrets, or production credentials in source control. Limit authorization context to facts required by the selected policy and bindings.

Security-sensitive integrations must place the actual side effect **after** the required Authorization and Verification checks in control flow. Logging a Decision and then executing anyway is not enforcement.

## Related public components

- [`atlasent-sdk`](https://github.com/Atlasent/atlasent-sdk) — language SDKs
- [`atlasent-action`](https://github.com/Atlasent/atlasent-action) — GitHub Actions integration
- [`atlasent-verify`](https://github.com/Atlasent/atlasent-verify) — offline evidence verifier
- [`atlasent-keys`](https://github.com/Atlasent/atlasent-keys) — public verification material

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
