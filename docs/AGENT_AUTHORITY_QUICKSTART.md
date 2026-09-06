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
const action = {
  action_type: "production.deploy",
  actor_id: "agent:ops-bot",
  environment: "production",
};

const decision = await evaluate(action);

if (decision.decision !== "allow") {
  throw new Error("Not authorized: stop and surface the resolution path");
}

const verification = await verify_permit({
  permit_token: decision.permit_token,
  ...action,
});

if (!verification.valid) {
  throw new Error("Authorization artifact did not verify");
}

const result = await runProtectedDeployment();
```

Use a specific Canon action type for the protected effect. The MCP `evaluate`
tool currently binds only the fields in its published schema: action type,
actor, environment, approvals, and change window. It does **not** accept an
arbitrary `context`, tool name, target, or argument digest.

Consequently, this MCP-only pattern is sufficient only when the selected action
type and policy already identify the protected effect at the required
granularity. If authorization must bind a concrete target or material payload,
use an AtlaSent API or integration path that accepts those fields at both
evaluation and permit verification. Do not treat `agent.tool.invoke` as
blanket authorization for an unspecified native tool call.

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
