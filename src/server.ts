/**
 * MCP server exposing AtlaSent authorization as tools.
 *
 *   evaluate       — ask for a decision; agent gates itself on the result
 *   verify_permit  — close the audit loop after the action runs
 *   deploy_service — DEMO protected tool: every call goes through `authorize()`
 *                    BEFORE executing the deploy. Denied calls never run.
 *
 * The `deploy_service` tool is the small end-to-end proof: it owns the
 * interception point. Look at its handler to see the exact pattern every
 * protected tool should follow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult, type ActionContext } from "./decision.js";
import {
  authorize,
  verify,
  getMode,
  evaluateAction,
  listPolicies,
  getPolicy,
  listAuditEvents,
  createPolicy,
  updatePolicy,
  deletePolicy,
  revokePermit,
  listPermits,
  issuePermit,
  verifyPermitV1,
  createApprovalRequest,
  resolveApprovalRequest,
  recordExecutionEvaluation,
  createWebhook,
  deleteWebhook,
} from "./engine.js";

export const VERSION = "1.0.0";

// Bounds protect the upstream policy engine and the local rule engine
// from a misbehaving / adversarial caller (e.g. an injected prompt that
// tells the model to send a megabyte-long approvals array). Limits are
// generous for legitimate use but cap the worst case.
const MAX_FIELD_LEN = 256;
const MAX_APPROVALS = 16;

const actionType = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .regex(
    /^[A-Za-z0-9_.\-:]+$/,
    "action_type must be lowercase identifier characters (A-Z, a-z, 0-9, _ . - :)",
  )
  .describe("The action the agent is about to perform (e.g. deploy, delete, merge, execute_query, send_email).");
const actorId = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .describe("Identifier for the user or service account the agent is acting on behalf of.");
const environment = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .describe("Target environment for the action (e.g. production, staging, development).");
const approvals = z
  .array(z.string().min(1).max(MAX_FIELD_LEN))
  .max(MAX_APPROVALS)
  .optional()
  .describe("Approval identifiers already obtained for this action (e.g. ticket IDs, reviewer handles).");
const changeWindow = z
  .string()
  .max(MAX_FIELD_LEN)
  .optional()
  .describe("ISO-8601 time window during which the change is permitted (e.g. 2025-01-15T02:00:00Z/PT4H).");

// Fields we'll keep verbatim in the structured stderr log. Anything
// not on the allowlist is either dropped (sensitive) or hashed-and-
// truncated (correlatable but not reversible). The audit flagged
// raw `actor_id` / `action_type` flowing into stderr — mostly safe
// for self-hosted MCP, but a shared log aggregator could surface
// per-user behaviour of the calling agent. See SECURITY_PLAN.md
// (atlasent-mcp-server LOW: stderr log redaction).
const LOG_SAFE_TOP_LEVEL_KEYS = new Set([
  "ts",
  "event",
  "mode",
  "decision",      // allow/deny/hold/error — the security-relevant bit
  "outcome",       // verify outcome — same shape, public
  "audit_id",      // correlation only, no user material
  "permit_token",  // already opaque
  "duration_ms",
]);

function _hashShort(s: string): string {
  // Cheap deterministic shortening — not crypto, just stable enough
  // that a log analyst can correlate two events for the same actor
  // without seeing the actor's identifier verbatim.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function _redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length === 0) return value;
    if (value.length <= 8) return `len=${value.length}`;
    return `h:${_hashShort(value)}:len=${value.length}`;
  }
  if (Array.isArray(value)) {
    return { _kind: "array", count: value.length };
  }
  if (typeof value === "object") {
    return { _kind: "object", keys: Object.keys(value as object).length };
  }
  return value;
}

function log(event: string, data: Record<string, unknown>): void {
  // Log to stderr so we don't interfere with MCP stdio messaging.
  const safe: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    mode: getMode(),
  };
  for (const [key, value] of Object.entries(data)) {
    if (LOG_SAFE_TOP_LEVEL_KEYS.has(key)) {
      safe[key] = value;
      continue;
    }
    if (key === "ctx" && value && typeof value === "object") {
      // Only the action_type is preserved as a low-cardinality string
      // (it comes from a controlled vocabulary of policy actions);
      // other context fields are redacted.
      const ctx = value as Record<string, unknown>;
      safe.ctx = {
        action_type:
          typeof ctx.action_type === "string" && ctx.action_type.length <= 64
            ? ctx.action_type
            : _redact(ctx.action_type),
        actor_id: _redact(ctx.actor_id),
        environment: _redact(ctx.environment),
        approvals: _redact(ctx.approvals),
        change_window: _redact(ctx.change_window),
      };
      continue;
    }
    safe[key] = _redact(value);
  }
  const line = JSON.stringify(safe);
  process.stderr.write(line + "\n");
}

// Per-tool token bucket. Caps the calls-per-second any single tool
// handler can sustain — protects the upstream policy engine from a
// runaway agent loop, and the local mode from busywork. Tunable via
// ATLASENT_MCP_RATE_LIMIT (calls per minute, default 600).
const _rateLimitState: Map<string, { tokens: number; updatedAt: number }> =
  new Map();

function _rateLimitPerMinute(): number {
  const raw = process.env.ATLASENT_MCP_RATE_LIMIT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}

export function _resetRateLimitForTests(): void {
  _rateLimitState.clear();
}

function rateLimitOk(toolName: string): boolean {
  const max = _rateLimitPerMinute();
  const refillPerMs = max / 60_000;
  const now = Date.now();
  const state = _rateLimitState.get(toolName) ?? { tokens: max, updatedAt: now };
  const elapsed = now - state.updatedAt;
  const refilled = Math.min(max, state.tokens + elapsed * refillPerMs);
  if (refilled < 1) {
    _rateLimitState.set(toolName, { tokens: refilled, updatedAt: now });
    return false;
  }
  _rateLimitState.set(toolName, { tokens: refilled - 1, updatedAt: now });
  return true;
}

// Live-API demos (ATLASENT_MODE=remote with a real key) expose mutating
// CRUD tools that call the hosted API directly — they do NOT pass
// through authorize(). An adversarial prompt or a hallucinated
// "clean up" step could destroy real policies, webhooks, or revoke
// live permits. Setting ATLASENT_MCP_READONLY=1 skips registration of
// the 7 mutating tools below. The demo flow (evaluate → deploy_service
// → verify_permit), all list/get/audit-read tools, and the
// approval-request workflow remain available.
const READONLY_DISABLED_TOOLS = new Set([
  "atlasent_create_policy",
  "atlasent_update_policy",
  "atlasent_delete_policy",
  "atlasent_create_webhook",
  "atlasent_delete_webhook",
  "atlasent_revoke_permit",
  "atlasent_permit",
]);

export function isToolDisabledByReadOnly(toolName: string): boolean {
  const flag = process.env.ATLASENT_MCP_READONLY;
  if (flag !== "1" && flag !== "true") return false;
  return READONLY_DISABLED_TOOLS.has(toolName);
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "@atlasent/mcp-server",
    version: VERSION,
  });

  if (
    process.env.ATLASENT_MCP_READONLY === "1" ||
    process.env.ATLASENT_MCP_READONLY === "true"
  ) {
    log("server.readonly_mode", {
      disabled_tools: [...READONLY_DISABLED_TOOLS].sort(),
    });
  }

  // -------------------------------------------------------------------------
  // evaluate — for agents that gate their own tool calls
  // -------------------------------------------------------------------------
  server.registerTool(
    "evaluate",
    {
      title: "AtlaSent — Evaluate Action",
      description:
        "Call this BEFORE performing any sensitive action. Returns a Decision: " +
        "`allow` (use the permit_token and proceed), `deny` (you MUST NOT proceed), " +
        "or `hold` (action is queued for human review — do not proceed, inform the user).",
      inputSchema: z.object({
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
      }),
      annotations: {
        title: "AtlaSent — Evaluate Action",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("evaluate")) {
        const decision = {
          decision: "deny" as const,
          reason: "MCP tool rate limit exceeded — slow down and retry",
        };
        log("evaluate.rate_limited", { decision });
        return toolResult(decision);
      }
      const ctx: ActionContext = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
      };
      const decision = await authorize(ctx);
      log("evaluate", { ctx, decision });
      return toolResult(decision);
    },
  );

  // -------------------------------------------------------------------------
  // verify_permit — close the audit loop
  // -------------------------------------------------------------------------
  server.registerTool(
    "verify_permit",
    {
      title: "AtlaSent — Verify Permit",
      description:
        "Call this AFTER completing an authorized action. Confirms the permit " +
        "issued by `evaluate` is still valid. Outcome is `verified`, `expired`, " +
        "`invalid`, or `error`. If `valid` is false, the action should be flagged " +
        "for review.",
      inputSchema: z.object({
        permit_token: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The permit_token returned by a prior evaluate call."),
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
      }),
      annotations: {
        title: "AtlaSent — Verify Permit",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("verify_permit")) {
        const result = {
          outcome: "error" as const,
          valid: false,
          reason: "MCP tool rate limit exceeded — slow down and retry",
        };
        log("verify_permit.rate_limited", { result });
        return toolResult(result);
      }
      const ctx: ActionContext = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
      };
      const result = await verify(args.permit_token, ctx);
      log("verify_permit", { ctx, permit_token: args.permit_token, result });
      return toolResult(result);
    },
  );

  // -------------------------------------------------------------------------
  // deploy_service — DEMO protected tool
  //
  // This is the authorization-before-execution proof. The tool:
  //   1. builds an ActionContext
  //   2. calls authorize(ctx) — this is the INTERCEPTION POINT
  //   3. if decision is not "allow", returns the decision as-is (call blocked)
  //   4. otherwise executes, then returns the allow decision with the result
  //
  // In production, your domain tools live on other MCP servers. They call
  // AtlaSent's evaluate tool before executing. This demo co-locates the
  // pattern so you can run `evaluate → act → verify` end-to-end today.
  // -------------------------------------------------------------------------
  server.registerTool(
    "deploy_service",
    {
      title: "Demo: Deploy Service (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized by AtlaSent BEFORE the " +
        "deploy runs. Denied or held calls are blocked and never touch the target " +
        "system. On allow, the deploy executes and a permit_token is returned.",
      inputSchema: z.object({
        service_name: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Name of the service to deploy."),
        environment,
        actor_id: actorId,
        approvals,
        change_window: changeWindow,
      }),
      annotations: {
        title: "Demo: Deploy Service",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("deploy_service")) {
        const decision = {
          decision: "deny" as const,
          reason: "MCP tool rate limit exceeded — slow down and retry",
        };
        log("deploy_service.rate_limited", { decision });
        return toolResult(decision);
      }
      const ctx: ActionContext = {
        action_type: "deployment.production",
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("deploy_service.authorize", { service: args.service_name, ctx, decision });

      if (decision.decision !== "allow") {
        log("deploy_service.blocked", { service: args.service_name, reason: (decision as { reason?: string }).reason });
        return toolResult(decision);
      }
      // --------------------------------------------------------------------

      // Execute the deploy (simulated — real integrations would call out here).
      const result = {
        status: "deployed",
        service: args.service_name,
        environment: args.environment,
        deployed_at: new Date().toISOString(),
      };
      log("deploy_service.executed", { service: args.service_name, permit_token: decision.permit_token, result });

      return toolResult(decision, { result });
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_evaluate — evaluate an action against AtlaSent policies
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_evaluate",
    {
      title: "AtlaSent — Evaluate Action (v1)",
      description:
        "Evaluate an action against AtlaSent policies. Returns a decision " +
        "(allow/deny/hold/escalate) and a permit token if allowed.",
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Who is performing the action (user ID, service name)."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("What action is being performed (e.g. 'deployment.production', 'records.delete')."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("What resource is being acted on (e.g. 'env:prod', 'table:patients')."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional key/value context for policy evaluation."),
      }),
      annotations: {
        title: "AtlaSent — Evaluate Action (v1)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_evaluate")) {
        const decision = {
          decision: "deny" as const,
          reason: "MCP tool rate limit exceeded — slow down and retry",
        };
        log("atlasent_evaluate.rate_limited", { decision });
        return toolResult(decision);
      }
      try {
        const result = await evaluateAction({
          subject: args.subject,
          action: args.action,
          resource: args.resource,
          org_id: args.org_id,
          context: args.context as Record<string, unknown> | undefined,
        });
        log("atlasent_evaluate", { decision: result.decision });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(result.decision !== "allow" ? { isError: true } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_evaluate.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_policies — list all policies for an organization
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_policies",
    {
      title: "AtlaSent — List Policies",
      description: "List all policies for an organization.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        status: z
          .enum(["draft", "shadow", "enforce"])
          .optional()
          .describe("Filter by policy status: 'draft', 'shadow', or 'enforce'."),
      }),
      annotations: {
        title: "AtlaSent — List Policies",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_policies")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await listPolicies({ org_id: args.org_id, status: args.status });
        log("atlasent_list_policies", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_list_policies.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_get_policy — get a single policy by ID
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_get_policy",
    {
      title: "AtlaSent — Get Policy",
      description: "Get a single policy by ID.",
      inputSchema: z.object({
        policy_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Policy ID."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
      }),
      annotations: {
        title: "AtlaSent — Get Policy",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_get_policy")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await getPolicy({ policy_id: args.policy_id, org_id: args.org_id });
        log("atlasent_get_policy", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_get_policy.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_audit_events — query the audit event log
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_audit_events",
    {
      title: "AtlaSent — List Audit Events",
      description:
        "Query the audit event log. Use to verify that an evaluation was recorded, " +
        "or to investigate recent decisions.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        evaluation_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to a specific evaluation ID."),
        from: z
          .string()
          .optional()
          .describe("Start of time range (ISO 8601 datetime)."),
        to: z
          .string()
          .optional()
          .describe("End of time range (ISO 8601 datetime)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .optional()
          .describe("Maximum number of events to return (default 20, max 100)."),
      }),
      annotations: {
        title: "AtlaSent — List Audit Events",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_audit_events")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await listAuditEvents({
          org_id: args.org_id,
          evaluation_id: args.evaluation_id,
          from: args.from,
          to: args.to,
          limit: args.limit ?? 20,
        });
        log("atlasent_list_audit_events", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_list_audit_events.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_policy — create a new policy
  // -------------------------------------------------------------------------
  const policyCommonFields = {
    title: z
      .string()
      .min(1)
      .max(MAX_FIELD_LEN)
      .describe("Human-readable policy title."),
    description: z
      .string()
      .max(2048)
      .optional()
      .describe("Longer policy description."),
    policy_type: z
      .string()
      .min(1)
      .max(MAX_FIELD_LEN)
      .describe("Policy type (e.g. 'access_control', 'data_governance')."),
    rules: z
      .array(z.record(z.string(), z.unknown()))
      .max(256)
      .describe("Ordered list of rule objects evaluated by the engine."),
    version: z
      .string()
      .max(MAX_FIELD_LEN)
      .optional()
      .describe("Policy version (semver). Defaults server-side to 1.0.0."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe("Lower numbers evaluate first. Default 100."),
    applies_to: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Scope selector for which subjects/resources this policy targets."),
    actions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Allow/deny/hold action mapping for matched rules."),
    effective_at: z
      .string()
      .max(MAX_FIELD_LEN)
      .optional()
      .describe("ISO 8601 datetime when the policy becomes effective."),
    expires_at: z
      .string()
      .max(MAX_FIELD_LEN)
      .optional()
      .describe("ISO 8601 datetime when the policy expires."),
  };

  if (!isToolDisabledByReadOnly("atlasent_create_policy"))
  server.registerTool(
    "atlasent_create_policy",
    {
      title: "AtlaSent — Create Policy",
      description:
        "Create a new policy in draft state. Requires the `policies:write` " +
        "scope on the API key. Returns the persisted policy row.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        policy_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Stable policy identifier (slug-like). Must be unique within the org."),
        ...policyCommonFields,
        rules: policyCommonFields.rules.min(1),
      }),
      annotations: {
        title: "AtlaSent — Create Policy",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_create_policy")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await createPolicy({
          org_id: args.org_id,
          policy_id: args.policy_id,
          title: args.title,
          policy_type: args.policy_type,
          rules: args.rules,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.version !== undefined ? { version: args.version } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.applies_to !== undefined ? { applies_to: args.applies_to } : {}),
          ...(args.actions !== undefined ? { actions: args.actions } : {}),
          ...(args.effective_at !== undefined ? { effective_at: args.effective_at } : {}),
          ...(args.expires_at !== undefined ? { expires_at: args.expires_at } : {}),
        });
        log("atlasent_create_policy", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_create_policy.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_update_policy — partial update of an existing policy
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_update_policy"))
  server.registerTool(
    "atlasent_update_policy",
    {
      title: "AtlaSent — Update Policy",
      description:
        "Partial update (PATCH) of an existing policy. Only the fields you " +
        "supply are changed. Requires the `policies:write` scope. Returns the " +
        "updated policy row.",
      inputSchema: z.object({
        policy_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Policy ID to update."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        title: policyCommonFields.title.optional(),
        description: policyCommonFields.description,
        policy_type: policyCommonFields.policy_type.optional(),
        rules: policyCommonFields.rules.optional(),
        version: policyCommonFields.version,
        priority: policyCommonFields.priority,
        applies_to: policyCommonFields.applies_to,
        actions: policyCommonFields.actions,
        effective_at: policyCommonFields.effective_at,
        expires_at: policyCommonFields.expires_at,
        status: z
          .enum(["draft", "shadow", "enforce", "archived"])
          .optional()
          .describe("Lifecycle status to transition the policy into."),
      }),
      annotations: {
        title: "AtlaSent — Update Policy",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_update_policy")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await updatePolicy({
          policy_id: args.policy_id,
          org_id: args.org_id,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.policy_type !== undefined ? { policy_type: args.policy_type } : {}),
          ...(args.rules !== undefined ? { rules: args.rules } : {}),
          ...(args.version !== undefined ? { version: args.version } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.applies_to !== undefined ? { applies_to: args.applies_to } : {}),
          ...(args.actions !== undefined ? { actions: args.actions } : {}),
          ...(args.effective_at !== undefined ? { effective_at: args.effective_at } : {}),
          ...(args.expires_at !== undefined ? { expires_at: args.expires_at } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
        });
        log("atlasent_update_policy", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_update_policy.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_revoke_permit — revoke an issued permit
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_revoke_permit"))
  server.registerTool(
    "atlasent_revoke_permit",
    {
      title: "AtlaSent — Revoke Permit",
      description:
        "Revoke a permit so subsequent verify/consume calls fail with " +
        "permit_revoked. Idempotent: revoking an already-revoked permit " +
        "succeeds. Requires the `permits:revoke` scope on the API key.",
      inputSchema: z.object({
        permit_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("ID of the permit to revoke."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        reason: z
          .string()
          .max(1024)
          .optional()
          .describe("Free-text reason recorded with the revocation."),
      }),
      annotations: {
        title: "AtlaSent — Revoke Permit",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_revoke_permit")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await revokePermit({
          permit_id: args.permit_id,
          org_id: args.org_id,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        log("atlasent_revoke_permit", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_revoke_permit.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_permits — paginated permit list for an organization
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_permits",
    {
      title: "AtlaSent — List Permits",
      description:
        "List permits issued for an organization. Supports filters " +
        "(status, actor_id, action_type, time range) and cursor pagination.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        status: z
          .enum(["issued", "verified", "consumed", "revoked", "expired"])
          .optional()
          .describe("Filter by permit lifecycle status."),
        actor_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to permits issued for a specific actor."),
        action_type: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to a specific action type."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Start of created_at time range (ISO 8601)."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("End of created_at time range (ISO 8601)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum number of permits to return (default 50, max 500)."),
        cursor: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Opaque cursor (created_at) returned by the previous page."),
      }),
      annotations: {
        title: "AtlaSent — List Permits",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_permits")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await listPermits({
          org_id: args.org_id,
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.actor_id !== undefined ? { actor_id: args.actor_id } : {}),
          ...(args.action_type !== undefined ? { action_type: args.action_type } : {}),
          ...(args.from !== undefined ? { from: args.from } : {}),
          ...(args.to !== undefined ? { to: args.to } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        });
        log("atlasent_list_permits", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_list_permits.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_permit — issue a permit token
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_permit"))
  server.registerTool(
    "atlasent_permit",
    {
      title: "AtlaSent — Issue Permit",
      description:
        "Issue a permit token that pre-authorizes a subject to perform an action on a " +
        "resource. Call this when you need to mint a time-limited permit outside of the " +
        "standard evaluate flow — for example when a human approver grants access ahead " +
        "of time. Returns a permit_token the agent can present when executing the action.",
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Who is being granted the permit (user ID, service name)."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The action being permitted (e.g. 'deployment.production')."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The resource the action targets (e.g. 'env:prod')."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        ttl_seconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How long the permit is valid in seconds (default determined by server policy)."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional key/value context to embed in the permit."),
      }),
      annotations: {
        title: "AtlaSent — Issue Permit",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_permit")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await issuePermit({
          subject: args.subject,
          action: args.action,
          resource: args.resource,
          org_id: args.org_id,
          ttl_seconds: args.ttl_seconds,
          context: args.context as Record<string, unknown> | undefined,
        });
        log("atlasent_permit", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_permit.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_verify_permit — verify a permit token (v1 REST)
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_verify_permit",
    {
      title: "AtlaSent — Verify Permit (v1)",
      description:
        "Verify that a permit token is currently valid for a subject/action/resource " +
        "combination. Call this after completing an authorized action to close the audit " +
        "loop, or before executing an action when a permit token was issued out-of-band. " +
        "Returns { valid, outcome, reason? }.",
      inputSchema: z.object({
        permit_token: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The permit token to verify."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("The action the permit should cover (optional but recommended for strict verification)."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("The resource the permit should cover (optional but recommended for strict verification)."),
      }),
      annotations: {
        title: "AtlaSent — Verify Permit (v1)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_verify_permit")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await verifyPermitV1({
          permit_token: args.permit_token,
          org_id: args.org_id,
          action: args.action,
          resource: args.resource,
        });
        log("atlasent_verify_permit", { permit_token: args.permit_token });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_verify_permit.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_approval_request — request human approval for an action
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_create_approval_request",
    {
      title: "AtlaSent — Create Approval Request",
      description:
        "Submit a request for human approval before performing a sensitive action. " +
        "Call this when `atlasent_evaluate` returns `hold`, or proactively when the " +
        "agent knows an action requires human sign-off. Returns an `approval_request_id` " +
        "to poll for resolution. Do not proceed with the action until the request is " +
        "approved via `atlasent_resolve_approval_request`.",
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Who is requesting approval (user ID, service name)."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The action requiring approval (e.g. 'delete:production-db')."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The resource being acted upon (e.g. 'db:prod-postgres')."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        justification: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Why the action is needed — shown to human approvers."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional key/value context for the approver."),
      }),
      annotations: {
        title: "AtlaSent — Create Approval Request",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_create_approval_request")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await createApprovalRequest({
          subject: args.subject,
          action: args.action,
          resource: args.resource,
          org_id: args.org_id,
          justification: args.justification,
          context: args.context as Record<string, unknown> | undefined,
        });
        log("atlasent_create_approval_request", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_create_approval_request.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_resolve_approval_request — approve or deny a pending request
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_resolve_approval_request",
    {
      title: "AtlaSent — Resolve Approval Request",
      description:
        "Approve or deny a pending approval request. Call this when acting as (or on " +
        "behalf of) a human approver who has reviewed an `atlasent_create_approval_request`. " +
        "After approval, the subject can proceed with the action. After denial, the subject " +
        "must not proceed and should be notified.",
      inputSchema: z.object({
        approval_request_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The approval request ID returned by atlasent_create_approval_request."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        resolution: z
          .enum(["approve", "deny"])
          .describe("The resolution decision: 'approve' to allow the action, 'deny' to block it."),
        resolver_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Identity of the person or service making the resolution decision."),
        comment: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Optional comment explaining the resolution decision (recorded in audit log)."),
      }),
      annotations: {
        title: "AtlaSent — Resolve Approval Request",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_resolve_approval_request")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await resolveApprovalRequest({
          approval_request_id: args.approval_request_id,
          org_id: args.org_id,
          resolution: args.resolution,
          resolver_id: args.resolver_id,
          comment: args.comment,
        });
        log("atlasent_resolve_approval_request", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_resolve_approval_request.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_delete_policy — permanently delete a policy
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_delete_policy"))
  server.registerTool(
    "atlasent_delete_policy",
    {
      title: "AtlaSent — Delete Policy",
      description:
        "Permanently delete an authorization policy. Call this only when a policy " +
        "is no longer needed and should be removed entirely. To disable without " +
        "deleting, use `atlasent_update_policy` to set status to 'archived'. " +
        "Deletion is irreversible.",
      inputSchema: z.object({
        policy_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The ID of the policy to delete."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
      }),
      annotations: {
        title: "AtlaSent — Delete Policy",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_delete_policy")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await deletePolicy({
          policy_id: args.policy_id,
          org_id: args.org_id,
        });
        log("atlasent_delete_policy", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_delete_policy.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_record_execution_evaluation — record the outcome of an execution
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_record_execution_evaluation",
    {
      title: "AtlaSent — Record Execution Evaluation",
      description:
        "Record the outcome of executing an action that was previously authorized. " +
        "Call this after an authorized action completes (successfully or not) to close " +
        "the full audit loop: evaluate → execute → record. This links the execution " +
        "result back to the original evaluation in the audit log.",
      inputSchema: z.object({
        evaluation_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The evaluation ID from the prior atlasent_evaluate call."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        outcome: z
          .enum(["success", "failure", "skipped"])
          .describe("The execution outcome: 'success', 'failure', or 'skipped' (action was authorized but not run)."),
        executed_at: z
          .string()
          .optional()
          .describe("ISO 8601 datetime when the action executed (defaults to now on the server)."),
        details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional execution details to store in the audit record."),
      }),
      annotations: {
        title: "AtlaSent — Record Execution Evaluation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_record_execution_evaluation")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await recordExecutionEvaluation({
          evaluation_id: args.evaluation_id,
          org_id: args.org_id,
          outcome: args.outcome,
          executed_at: args.executed_at,
          details: args.details as Record<string, unknown> | undefined,
        });
        log("atlasent_record_execution_evaluation", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_record_execution_evaluation.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_webhook — register a webhook for AtlaSent events
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_create_webhook"))
  server.registerTool(
    "atlasent_create_webhook",
    {
      title: "AtlaSent — Create Webhook",
      description:
        "Register a webhook endpoint to receive real-time AtlaSent event notifications. " +
        "Call this to subscribe an external service to authorization events such as " +
        "'evaluation.allow', 'evaluation.deny', 'approval.requested', or 'permit.revoked'. " +
        "Returns a webhook_id and optional signing secret for verifying payloads.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        url: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("HTTPS URL where AtlaSent will POST event payloads."),
        events: z
          .array(z.string().min(1).max(MAX_FIELD_LEN))
          .min(1)
          .max(32)
          .describe("List of event types to subscribe to (e.g. ['evaluation.deny', 'approval.requested'])."),
        description: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Human-readable description of what this webhook is for."),
        secret: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Optional HMAC signing secret. If omitted, AtlaSent generates one and returns it."),
      }),
      annotations: {
        title: "AtlaSent — Create Webhook",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_create_webhook")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await createWebhook({
          org_id: args.org_id,
          url: args.url,
          events: args.events,
          description: args.description,
          secret: args.secret,
        });
        log("atlasent_create_webhook", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_create_webhook.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_delete_webhook — remove a registered webhook
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_delete_webhook"))
  server.registerTool(
    "atlasent_delete_webhook",
    {
      title: "AtlaSent — Delete Webhook",
      description:
        "Permanently remove a registered webhook. Call this when an endpoint is no " +
        "longer reachable, when a service integration is being decommissioned, or when " +
        "you need to rotate to a new URL. After deletion, AtlaSent stops sending events " +
        "to the webhook URL immediately.",
      inputSchema: z.object({
        webhook_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The webhook ID returned by atlasent_create_webhook."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
      }),
      annotations: {
        title: "AtlaSent — Delete Webhook",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_delete_webhook")) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP tool rate limit exceeded — slow down and retry" }) }],
          isError: true,
        };
      }
      try {
        const result = await deleteWebhook({
          webhook_id: args.webhook_id,
          org_id: args.org_id,
        });
        log("atlasent_delete_webhook", {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("atlasent_delete_webhook.error", { error: msg });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
