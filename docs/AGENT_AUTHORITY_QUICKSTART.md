# Agent Authority Quickstart

AtlaSent is an execution-time organizational authority service for consequential actions.

> Agents may automate the path to authority. They may not manufacture the authority.

Use AtlaSent when an agent is about to perform a consequential action such as a production deployment, privileged infrastructure change, access change, SaaS administrative mutation, or another action governed by a Protected Action Pack.

## The safe pattern

1. Identify the exact consequential action.
2. Determine the AtlaSent organization and protected-action context.
3. Ask AtlaSent whether the action is authorized now.
4. If the decision is non-allow, stop and surface the reason / required resolution.
5. If allowed, verify the bounded permit at the execution boundary.
6. Execute the native effect only after permit verification succeeds.
7. Record the result/evidence where the integration supports it.

```text
Agent intent
  → AtlaSent evaluate
      deny / hold / error → STOP + explain next action
      allow → bounded permit
  → verify permit at execution boundary
      invalid / expired / replayed / mismatch → STOP
      verified → native effect may execute
  → outcome / evidence / revalidation
```

## What an agent may automate during setup

An agent may typically:

- discover whether AtlaSent already knows the organization;
- inspect supported protected actions;
- inventory execution surfaces and integrations;
- prepare a proposed Protected Action Pack / manifest;
- configure sandbox-safe inputs where authorized;
- run rehearsal scenarios;
- identify setup gaps;
- prepare resolution and activation context;
- resume after an authoritative approval has been recorded.

## Where the agent must stop

Do not self-assert:

- ownership of an organization;
- privileged connector consent;
- production authority;
- material approver designation;
- exception / risk acceptance;
- production activation.

Those boundaries require authoritative organizational proof or the appropriate human/organizational approval.

## Rehearsal before production

Before a real consequential effect, test representative outcomes:

- unverified actor → DENY;
- missing required approval → HOLD or DENY;
- SoD conflict → DENY;
- stale/invalid evidence → DENY;
- correct current authority + correct context → ALLOW, then permit verification.

A failed rehearsal should produce an actionable resolution: why it failed, who owns the fix, what evidence verifies closure, and what state follows.

## Runtime example

```ts
const toolArguments = {
  repository: "example/customer-production",
  pull_request: 123,
  expected_head_sha: "0123456789abcdef...",
};

// Use an RFC 8785-style canonical JSON encoder (or the integration's
// documented equivalent), not a raw JSON.stringify whose key order can vary.
const invocation = {
  tool: "github.merge_pull_request",
  target: "example/customer-production#123",
  environment: "production",
  arguments_sha256: sha256(canonicalJson(toolArguments)),
};

const decision = await evaluate({
  action_type: "agent.tool.invoke",
  actor_id: "agent:ops-bot",
  environment: invocation.environment,
  context: invocation,
});

if (decision.decision !== "allow") {
  throw new Error("Not authorized: stop and surface the resolution path");
}

const verification = await verify_permit({
  permit_token: decision.permit_token,
  action_type: "agent.tool.invoke",
  actor_id: "agent:ops-bot",
  environment: invocation.environment,
  context: invocation,
});

if (!verification.valid) {
  throw new Error("Authorization artifact did not verify for this exact tool call");
}

// Execute exactly the arguments whose canonical digest was evaluated and
// verified. Any tool, target, environment, or argument change requires a new
// evaluation and permit.
const result = await runProtectedTool(toolArguments);
```

The generic `agent.tool.invoke` action class is not authorization for any
arbitrary tool call. The concrete tool, target, environment, and canonical
arguments/payload digest are part of the authorization boundary and must be
identical at evaluation, verification, and execution. Prefer a more specific
Canon action type when one exists.

## Agent-facing vocabulary

- **Authority** — standing, scoped organizational right.
- **Authorization** — determination for this exact action now.
- **Approval** — evidence that may satisfy a policy condition; not the final authority result.
- **Decision** — allow / deny / hold / escalate.
- **Permit** — bounded positive authorization artifact.
- **Verification** — execution-boundary validation of the permit and bindings.
- **Resolution** — accountable work required to close a denied/held/setup condition.
- **Evidence / Proof** — retained authorization and outcome lineage.

## Start here

For installation, supported tools, and client configuration, see the main [README](../README.md).

For MCP-compatible hosts, the central rule is simple:

> Before a consequential tool acts, ask AtlaSent whether this exact action is authorized now—and verify the resulting permit before the effect occurs.
