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
  permit_token?: string;
  reason?: string;
  audit_id?: string;
  conditions?: string[];
  hold_id?: string;
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  const body: Record<string, unknown> = {
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    environment: ctx.environment,
  };
  if (ctx.approvals !== undefined) body.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) body.change_window = ctx.change_window;
  if (ctx.context !== undefined) body.context = ctx.context;

  const data = await post<RawEvaluate>("/v1-evaluate", body);

  if (data.decision === "allow") {
    if (!data.permit_token) throw new Error("Remote allowed the action but returned no permit_token");
    const out: Decision = { decision: "allow", permit_token: data.permit_token };
    if (data.audit_id) out.audit_id = data.audit_id;
    if (data.conditions?.length) out.conditions = data.conditions;
    return out;
  }

  if (data.decision === "hold" || data.decision === "escalate") {
    return {
      decision: "hold",
      reason: data.reason ?? "Held for human review",
      ...(data.hold_id && { hold_id: data.hold_id }),
      ...(data.audit_id && { audit_id: data.audit_id }),
    };
  }

  // Anything else (including "deny" or an unknown decision) is fail-closed.
  return {
    decision: "deny",
    reason: data.reason ?? `Denied (decision=${data.decision})`,
    ...(data.audit_id && { audit_id: data.audit_id }),
  };
}

interface RawVerify {
  outcome: string;
  valid: boolean;
  reason?: string;
  audit_id?: string;
}

async function verifyRemote(token: string, ctx: ActionContext): Promise<VerifyResult> {
  const body: Record<string, unknown> = {
    permit_token: token,
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    environment: ctx.environment,
  };
  if (ctx.approvals !== undefined) body.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) body.change_window = ctx.change_window;
  if (ctx.context !== undefined) body.context = ctx.context;

  const data = await post<RawVerify>("/v1-verify-permit", body);

  const outcome =
    data.outcome === "verified" || data.outcome === "expired" || data.outcome === "invalid"
      ? data.outcome
      : "error";

  return {
    outcome,
    valid: data.valid === true,
    ...(data.reason && { reason: data.reason }),
    ...(data.audit_id && { audit_id: data.audit_id }),
  };
}
