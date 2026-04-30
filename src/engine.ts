/**
 * Authorization engine — dispatches to a local rules engine or the hosted
 * AtlaSent API based on configuration.
 *
 * Mode selection (read on every call, so tests and hosts can toggle without
 * re-initializing the server):
 *
 *   ATLASENT_MODE=remote            → hosted AtlaSent API
 *   ATLASENT_MODE=local             → local rules engine
 *   (unset)                         → remote if ATLASENT_API_KEY and
 *                                      ATLASENT_BASE_URL are set, else local
 *
 * The hosted backend is a configuration swap, not a rewrite: every tool
 * handler calls `authorize(ctx)` and gets back the same Decision shape.
 */

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import { denyDecision } from "./decision.js";
import { authorizeLocal, verifyLocal } from "./localEngine.js";

const VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 10_000;

export type Mode = "local" | "remote";

export function getMode(): Mode {
  const explicit = process.env.ATLASENT_MODE?.toLowerCase();
  if (explicit === "remote") return "remote";
  if (explicit === "local") return "local";
  if (process.env.ATLASENT_API_KEY && process.env.ATLASENT_BASE_URL) return "remote";
  return "local";
}

export async function authorize(ctx: ActionContext): Promise<Decision> {
  try {
    return getMode() === "remote" ? await authorizeRemote(ctx) : authorizeLocal(ctx);
  } catch (err) {
    return denyDecision(err instanceof Error ? err.message : String(err));
  }
}

export async function verify(token: string, ctx: ActionContext): Promise<VerifyResult> {
  try {
    return getMode() === "remote" ? await verifyRemote(token, ctx) : verifyLocal(token, ctx);
  } catch (err) {
    return {
      outcome: "error",
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Remote (hosted AtlaSent backend)
// ---------------------------------------------------------------------------

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `@atlasent/mcp-server/${VERSION}`,
  };
  const key = process.env.ATLASENT_API_KEY;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const anon = process.env.ATLASENT_ANON_KEY;
  if (anon) headers["x-anon-key"] = anon;
  return headers;
}

function baseUrl(): string {
  return (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.com").replace(/\/+$/, "");
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AtlaSent API ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

interface RawEvaluate {
  decision: string;
  permit?: { id: string; status?: string; expires_at?: string };
  deny_reason?: string;
  evaluation_id?: string;
  // Server also returns matched_rule_id, matched_policy_id, deny_code,
  // risk: {level, score, reasons}, evaluated_at — currently unused by
  // mcp-server, kept on the wire for future telemetry surface.
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  // The atlasent-api edge function (supabase/functions/v1-evaluate)
  // reads payload.actor.id, payload.action.id, payload.context,
  // payload.environment. Approvals/change_window aren't first-class
  // on the wire — they ride inside `context` so the rule engine can
  // reach them via standard policy expressions.
  const context: Record<string, unknown> = {};
  if (ctx.approvals !== undefined) context.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) context.change_window = ctx.change_window;

  const body: Record<string, unknown> = {
    action: { id: ctx.action_type },
    actor: { id: ctx.actor_id },
    environment: ctx.environment,
    context,
  };

  const data = await post<RawEvaluate>("/v1-evaluate", body);

  if (data.decision === "allow") {
    const permitId = data.permit?.id;
    if (!permitId) throw new Error("Remote allowed the action but returned no permit.id");
    const out: Decision = { decision: "allow", permit_token: permitId };
    if (data.evaluation_id) out.audit_id = data.evaluation_id;
    return out;
  }

  if (data.decision === "hold" || data.decision === "escalate") {
    return {
      decision: "hold",
      reason: data.deny_reason ?? "Held for human review",
      ...(data.evaluation_id ? { audit_id: data.evaluation_id } : {}),
    };
  }

  // Anything else (including "deny" or an unknown decision) is fail-closed.
  return {
    decision: "deny",
    reason: data.deny_reason ?? `Denied (decision=${data.decision})`,
    ...(data.evaluation_id ? { audit_id: data.evaluation_id } : {}),
  };
}

interface RawVerify {
  valid?: boolean;
  outcome?: string;             // server emits "allow" | "deny"
  verify_error_code?: string;   // populated on outcome === "deny"
  reason?: string;
}

// Map the verify-permit handler's verify_error_code (see
// atlasent-api/supabase/functions/v1-verify-permit/handler.ts) onto the
// four-value outcome mcp-server publishes to MCP hosts.
const VERIFY_ERROR_TO_OUTCOME: Record<string, "expired" | "invalid" | "error"> = {
  PERMIT_EXPIRED: "expired",
  PERMIT_NOT_FOUND: "invalid",
  PERMIT_NOT_ALLOWED: "invalid",
  PERMIT_REVOKED: "invalid",
  PERMIT_ALREADY_USED: "invalid",
  ACTOR_MISMATCH: "invalid",
  ACTION_TYPE_MISMATCH: "invalid",
  MISSING_PERMIT: "invalid",
  UNAUTHORIZED: "error",
  INVALID_API_KEY: "error",
  INSUFFICIENT_SCOPE: "error",
  RATE_LIMITED: "error",
  INTERNAL_ERROR: "error",
};

async function verifyRemote(token: string, ctx: ActionContext): Promise<VerifyResult> {
  // Server reads body.permit_token, body.action_type, body.actor_id —
  // see handler.ts. Other fields (environment, approvals, change_window)
  // are not consulted by verify; we omit them to keep the wire honest.
  const body: Record<string, unknown> = {
    permit_token: token,
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
  };

  const data = await post<RawVerify>("/v1-verify-permit", body);

  if (data.valid === true && data.outcome === "allow") {
    return {
      outcome: "verified",
      valid: true,
      ...(data.reason ? { reason: data.reason } : {}),
    };
  }

  // Server denied or returned a non-affirmative shape — translate the
  // verify_error_code if present, otherwise fall through to "invalid"
  // (fail-closed: an unknown shape is never treated as success).
  const code = data.verify_error_code;
  const outcome: VerifyResult["outcome"] =
    code && code in VERIFY_ERROR_TO_OUTCOME ? VERIFY_ERROR_TO_OUTCOME[code]! : "invalid";

  return {
    outcome,
    valid: false,
    ...(data.reason ? { reason: data.reason } : {}),
  };
}
