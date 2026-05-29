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
import { registerV2Tools } from "./v2Tools.js";
import { registerComplianceTools } from "./complianceTools.js";
import { registerVqpTools } from "./vqpTools.js";

export const VERSION = "2.11.0";

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
    /^[A-Za-z0-9_.\.-:]+$/,
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

// ---------------------------------------------------------------------------
// Agent tool gate — outer layer for the two-layer authorization pattern.
//
// Call this FIRST in any protected tool handler, before any tool-specific
// authorize() call. It asks: "is this AI agent permitted to invoke any
// tool on this server at all?"
//
// Authorization primitives (evaluate, verify_permit) are intentionally
// excluded — they must always be callable to bootstrap the flow.
// ---------------------------------------------------------------------------
async function agentToolGate(
  toolName: string,
  actorId: string,
  environment: string,
): Promise<import("./decision.js").Decision | null> {
  const ctx: ActionContext = {
    action_type: "model.agent.execute_tool",
    actor_id: actorId,
    environment,
    tool_name: toolName,
  };
  const gate = await authorize(ctx);
  if (gate.decision !== "allow") {
    log("agent_tool_gate.blocked", { tool: toolName, actor: actorId, gate });
    return gate;
  }
  return null;
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
  // C.MCP2: v2 mutating tools also disabled in readonly mode
  "atlasent_evaluate_many",
  "atlasent_evaluate_stream",
  // Compliance mutating tools
  "atlasent_create_scim_user",
  "atlasent_patch_scim_user",
  "atlasent_delete_scim_user",
  "atlasent_upsert_siem_config",
  "atlasent_create_evidence_export",
  // VQP tools (mutating: generate writes vqp_snapshots, verify writes vqp_audit_log)
  "atlasent_vqp_generate",
  "atlasent_vqp_verify",
]);

export function isToolDisabledByReadOnly(toolName: string): boolean {
  const flag = process.env.ATLASENT_MCP_READONLY;
  if (flag !== "1" && flag !== "true") return false;
  return READONLY_DISABLED_TOOLS.has(toolName);
}

function toolError(e: unknown) {
  return toolResult({
    error: e instanceof Error ? e.message : String(e),
  });
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
          reasons: ["MCP tool rate limit exceeded — slow down and retry"],
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
          reasons: ["MCP tool rate limit exceeded — slow down and retry"],
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
  // deploy_service — protected tool
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
      title: "Deploy Service (authorization-gated)",
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
        title: "Deploy Service",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("deploy_service")) {
        const decision = {
          decision: "deny" as const,
          reasons: ["MCP tool rate limit exceeded — slow down and retry"],
        };
        log("deploy_service.rate_limited", { decision });
        return toolResult(decision);
      }

      // Agent tool gate: check model.agent.execute_tool before deploy-specific authorization.
      const agentGate = await agentToolGate("deploy_service", args.actor_id, args.environment);
      if (agentGate !== null) return toolResult(agentGate);

      const ctx: ActionContext = {
        action_type: "production.deploy",
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("deploy_service.authorize", { service: args.service_name, ctx, decision });

      if (decision.decision !== "allow") {
        log("deploy_service.blocked", { service: args.service_name, reasons: (decision as { reasons?: string[] }).reasons });
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
      title: "AtlaSent — Evaluate (Remote API)",
      description:
        "Evaluate an action against your published AtlaSent policies. " +
        "Returns allow/deny/hold/escalate with a permitToken on allow. " +
        "Use this when ATLASENT_MODE=remote and you need to gate an action " +
        "against your hosted policy engine.",
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The actor performing the action (e.g. 'user:alice', 'service:deploy-bot')."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("What action is being performed (e.g. 'production.deploy', 'records.delete')."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The resource being acted on (e.g. 'env:prod', 'db:customers')."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the policy."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Key-value context matched against constraint rules."),
        explain: z
          .boolean()
          .optional()
          .describe("When true, populates risk_envelope.factors with a per-factor score breakdown"),
      }),
      annotations: {
        title: "AtlaSent — Evaluate (Remote API)",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (isToolDisabledByReadOnly("atlasent_evaluate")) {
        return toolResult({ decision: "deny", reasons: ["Tool disabled: ATLASENT_MCP_READONLY=1"] });
      }
      if (!rateLimitOk("atlasent_evaluate")) {
        return toolResult({ decision: "deny", reasons: ["MCP tool rate limit exceeded — slow down and retry"] });
      }
      try {
        const result = await evaluateAction({
          subject: args.subject,
          action: args.action,
          resource: args.resource,
          org_id: args.org_id,
          context: args.context,
          ...(args.explain !== undefined ? { explain: args.explain } : {}),
        });
        log("atlasent_evaluate", { result });
        return toolResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_policies
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_policies",
    {
      title: "AtlaSent — List Policies",
      description: "List all constraint bundles / policies for this organization.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID to list policies for."),
        status: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter by status (e.g. 'draft', 'published', 'archived')."),
      }),
      annotations: {
        title: "AtlaSent — List Policies",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_policies")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await listPolicies({ org_id: args.org_id, status: args.status });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_get_policy
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_get_policy",
    {
      title: "AtlaSent — Get Policy",
      description: "Retrieve a single constraint bundle / policy by ID.",
      inputSchema: z.object({
        policy_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The bundle ID returned by list_policies or create_policy."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the policy."),
      }),
      annotations: {
        title: "AtlaSent — Get Policy",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_get_policy")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await getPolicy({ policy_id: args.policy_id, org_id: args.org_id });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_audit_events
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_audit_events",
    {
      title: "AtlaSent — List Audit Events",
      description: "Retrieve recent evaluation events from the audit log.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID to fetch audit events for."),
        evaluation_id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to events for a specific evaluation ID."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 start timestamp for the query window."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 end timestamp for the query window."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of events to return (default 20, max 100)."),
      }),
      annotations: {
        title: "AtlaSent — List Audit Events",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_audit_events")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await listAuditEvents({
          org_id: args.org_id,
          evaluation_id: args.evaluation_id,
          from: args.from,
          to: args.to,
          limit: args.limit,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_policy (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_create_policy")) {
    server.registerTool(
      "atlasent_create_policy",
      {
        title: "AtlaSent — Create Policy",
        description:
          "Create a new constraint bundle for an action. " +
          "The bundle starts in 'draft' status — call update_policy to publish it.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that will own the policy."),
          policy_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Client-assigned unique ID for this policy bundle (e.g. 'deploy-gate')."),
          title: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Human-readable policy title."),
          policy_type: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Policy type (e.g. 'access_control', 'approval_gate')."),
          rules: z
            .array(z.record(z.string(), z.unknown()))
            .describe("Ordered list of rules — first match wins."),
          description: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Optional human-readable description."),
          version: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Semantic version string (e.g. '1.0.0')."),
          priority: z
            .number()
            .int()
            .optional()
            .describe("Evaluation priority (lower number = higher priority)."),
          applies_to: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Scope selector controlling which requests this policy applies to."),
          actions: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Action-specific configuration."),
          effective_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("ISO-8601 timestamp when the policy becomes effective."),
          expires_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("ISO-8601 timestamp when the policy expires."),
        }),
        annotations: {
          title: "AtlaSent — Create Policy",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_create_policy")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await createPolicy({
            org_id: args.org_id,
            policy_id: args.policy_id,
            title: args.title,
            policy_type: args.policy_type,
            rules: args.rules,
            description: args.description,
            version: args.version,
            priority: args.priority,
            applies_to: args.applies_to,
            actions: args.actions,
            effective_at: args.effective_at,
            expires_at: args.expires_at,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_update_policy (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_update_policy")) {
    server.registerTool(
      "atlasent_update_policy",
      {
        title: "AtlaSent — Update Policy",
        description:
          "Update a constraint bundle — change rules, title, or publish/archive it. " +
          "Only fields you provide are updated; omitted fields are unchanged.",
        inputSchema: z.object({
          policy_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("ID of the bundle to update."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the policy."),
          title: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("New title for the policy."),
          status: z
            .string()
            .optional()
            .describe("New lifecycle status (e.g. 'draft', 'published', 'archived', 'enforce')."),
          priority: z
            .number()
            .int()
            .optional()
            .describe("New evaluation priority (lower number = higher priority)."),
          rules: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe("Replacement rules array (replaces all existing rules)."),
          description: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("New description."),
          version: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("New semantic version string."),
          applies_to: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Updated scope selector."),
          actions: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Updated action-specific configuration."),
          effective_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Updated ISO-8601 effective timestamp."),
          expires_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Updated ISO-8601 expiry timestamp."),
        }),
        annotations: {
          title: "AtlaSent — Update Policy",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_update_policy")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await updatePolicy({
            policy_id: args.policy_id,
            org_id: args.org_id,
            title: args.title,
            status: args.status,
            priority: args.priority,
            rules: args.rules,
            description: args.description,
            version: args.version,
            applies_to: args.applies_to,
            actions: args.actions,
            effective_at: args.effective_at,
            expires_at: args.expires_at,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_delete_policy (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_delete_policy")) {
    server.registerTool(
      "atlasent_delete_policy",
      {
        title: "AtlaSent — Delete Policy",
        description: "Permanently delete a constraint bundle. Prefer archiving over deleting.",
        inputSchema: z.object({
          policy_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("ID of the bundle to delete."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the policy."),
        }),
        annotations: {
          title: "AtlaSent — Delete Policy",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_delete_policy")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await deletePolicy({ policy_id: args.policy_id, org_id: args.org_id });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_revoke_permit (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_revoke_permit")) {
    server.registerTool(
      "atlasent_revoke_permit",
      {
        title: "AtlaSent — Revoke Permit",
        description:
          "Revoke a permit before it expires. The permit immediately becomes " +
          "invalid for verify_permit calls.",
        inputSchema: z.object({
          permitToken: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The permit token to revoke."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the permit."),
          reasons: z
            .array(z.string().max(MAX_FIELD_LEN))
            .optional()
            .describe("Human-readable reasons for revocation."),
        }),
        annotations: {
          title: "AtlaSent — Revoke Permit",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_revoke_permit")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await revokePermit({
            permitToken: args.permitToken,
            org_id: args.org_id,
            reasons: args.reasons,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_list_permits
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_permits",
    {
      title: "AtlaSent — List Permits",
      description: "List issued permit tokens for audit and monitoring.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID to list permits for."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of permits to return (default 20)."),
        status: z
          .enum(["active", "consumed", "expired", "revoked", "issued"])
          .optional()
          .describe("Filter by permit status."),
        actor_id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to permits issued for this actor."),
        action_type: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to permits for this action type."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 start timestamp filter."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 end timestamp filter."),
        cursor: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Pagination cursor from a previous response."),
      }),
      annotations: {
        title: "AtlaSent — List Permits",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_permits")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await listPermits({
          org_id: args.org_id,
          limit: args.limit,
          status: args.status,
          actor_id: args.actor_id,
          action_type: args.action_type,
          from: args.from,
          to: args.to,
          cursor: args.cursor,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_permit (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_permit")) {
    server.registerTool(
      "atlasent_permit",
      {
        title: "AtlaSent — Issue Permit",
        description:
          "Manually issue a permit token for an action. Use for pre-authorized " +
          "operations where a full evaluate call is not practical.",
        inputSchema: z.object({
          subject: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The actor the permit is issued for (e.g. 'user:alice')."),
          action: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The action being permitted (e.g. 'production.deploy')."),
          resource: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The resource the permit applies to (e.g. 'env:prod')."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the policy."),
          ttl_seconds: z
            .number()
            .int()
            .min(60)
            .max(86400)
            .optional()
            .describe("How long the permit is valid in seconds (default 300, max 86400)."),
          context: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional context to bind to the permit."),
        }),
        annotations: {
          title: "AtlaSent — Issue Permit",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_permit")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await issuePermit({
            subject: args.subject,
            action: args.action,
            resource: args.resource,
            org_id: args.org_id,
            ttl_seconds: args.ttl_seconds,
            context: args.context,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_verify_permit
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_verify_permit",
    {
      title: "AtlaSent — Verify Permit (V1)",
      description:
        "Verify a permit token with full binding inputs against the V1 endpoint. " +
        "Use this for production verification — under-specified verification is a bypass vector.",
      inputSchema: z.object({
        permit_token: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The permit_token from a prior evaluate call."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that issued the permit."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Action to verify the permit against."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Resource to verify the permit against."),
      }),
      annotations: {
        title: "AtlaSent — Verify Permit (V1)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_verify_permit")) {
        return toolResult({ valid: false, outcome: "error", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await verifyPermitV1({
          permit_token: args.permit_token,
          org_id: args.org_id,
          action: args.action,
          resource: args.resource,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_approval_request
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_create_approval_request",
    {
      title: "AtlaSent — Create Approval Request",
      description:
        "Create an approval request for a held action. The request ID is returned " +
        "in the evaluate response when decision is 'hold'. Submit resolution via " +
        "atlasent_resolve_approval_request.",
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The actor requesting the approval (e.g. 'user:alice')."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The action requiring approval (e.g. 'delete:production-db')."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The resource the action targets (e.g. 'db:prod-postgres')."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the policy."),
        justification: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Human-readable justification for why the action is needed."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Context from the original evaluate call."),
      }),
      annotations: {
        title: "AtlaSent — Create Approval Request",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_create_approval_request")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await createApprovalRequest({
          subject: args.subject,
          action: args.action,
          resource: args.resource,
          org_id: args.org_id,
          justification: args.justification,
          context: args.context,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_resolve_approval_request
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_resolve_approval_request",
    {
      title: "AtlaSent — Resolve Approval Request",
      description:
        "Approve or deny an approval request. On approval, the held evaluation " +
        "may proceed; on denial, it stays blocked.",
      inputSchema: z.object({
        approval_request_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The approval_request_id from atlasent_create_approval_request."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the approval request."),
        resolution: z
          .enum(["approve", "deny"])
          .describe("Whether to approve or deny the request."),
        resolver_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Identity of the person or system resolving the request."),
        comment: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Optional comment explaining the resolution."),
      }),
      annotations: {
        title: "AtlaSent — Resolve Approval Request",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_resolve_approval_request")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await resolveApprovalRequest({
          approval_request_id: args.approval_request_id,
          org_id: args.org_id,
          resolution: args.resolution,
          resolver_id: args.resolver_id,
          comment: args.comment,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_record_execution_evaluation
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_record_execution_evaluation",
    {
      title: "AtlaSent — Record Execution Evaluation",
      description:
        "Record the outcome of an execution that was permitted by a prior evaluate " +
        "call. Closes the audit loop with the actual execution result.",
      inputSchema: z.object({
        evaluation_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The evaluation_id from the prior evaluate call."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the evaluation."),
        outcome: z
          .enum(["success", "failure", "skipped"])
          .describe("The actual outcome of the execution."),
        executed_at: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 timestamp when the execution completed."),
        details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional details about what was executed and the result."),
      }),
      annotations: {
        title: "AtlaSent — Record Execution Evaluation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_record_execution_evaluation")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await recordExecutionEvaluation({
          evaluation_id: args.evaluation_id,
          org_id: args.org_id,
          outcome: args.outcome,
          executed_at: args.executed_at,
          details: args.details,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_webhook (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_create_webhook")) {
    server.registerTool(
      "atlasent_create_webhook",
      {
        title: "AtlaSent — Create Webhook",
        description: "Register a webhook URL to receive evaluation events.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID to register the webhook for."),
          url: z
            .string()
            .url()
            .describe("The HTTPS URL to deliver events to."),
          events: z
            .array(z.string().min(1).max(MAX_FIELD_LEN))
            .describe("Event types to subscribe to (e.g. ['evaluation.deny', 'permit.issued'])."),
          description: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Optional human-readable description of this webhook."),
          secret: z
            .string()
            .min(8)
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Signing secret for HMAC verification of payloads."),
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
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await createWebhook({
            org_id: args.org_id,
            url: args.url,
            events: args.events,
            description: args.description,
            secret: args.secret,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_delete_webhook (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_delete_webhook")) {
    server.registerTool(
      "atlasent_delete_webhook",
      {
        title: "AtlaSent — Delete Webhook",
        description: "Remove a registered webhook.",
        inputSchema: z.object({
          webhook_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("ID of the webhook to delete."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the webhook."),
        }),
        annotations: {
          title: "AtlaSent — Delete Webhook",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_delete_webhook")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await deleteWebhook({ webhook_id: args.webhook_id, org_id: args.org_id });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // V2 Wave B tools — atlasent_evaluate_many, atlasent_evaluate_stream,
  // atlasent_query. Closed-by-default: 404 from the API surfaces as a
  // typed `feature_not_enabled` error.
  // -------------------------------------------------------------------------
  registerV2Tools(server);

  // -------------------------------------------------------------------------
  // Compliance tools: SCIM provisioning, SIEM delivery, evidence exports.
  // -------------------------------------------------------------------------
  registerComplianceTools(server);

  // -------------------------------------------------------------------------
  // VQP tools: generate snapshots, verify hash integrity, detect model drift.
  // -------------------------------------------------------------------------
  registerVqpTools(server);

  return server;
}
