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
import { authorize, verify, getMode } from "./engine.js";

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

export function createServer(): McpServer {
  const server = new McpServer({
    name: "@atlasent/mcp-server",
    version: VERSION,
  });

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
        action_type: "deploy",
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

  return server;
}
