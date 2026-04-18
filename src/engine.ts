/**
 * Authorization engine — dispatches to a local rules engine or the hosted
 * AtlaSent v2 API based on configuration.
 *
 * Mode selection (read on every call, so tests and hosts can toggle without
 * re-initializing the server):
 *
 *   ATLASENT_MODE=remote            → hosted AtlaSent API
 *   ATLASENT_MODE=local             → local rules engine (offline fallback)
 *   (unset)                         → remote if ATLASENT_API_KEY and
 *                                      ATLASENT_API_URL are set, else local
 *
 * Breaking change from v1: env var is now ATLASENT_API_URL (was ATLASENT_BASE_URL).
 */

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import { denyDecision } from "./decision.js";
import { authorizeLocal, verifyLocal } from "./localEngine.js";

const VERSION = "2.0.0";
const REQUEST_TIMEOUT_MS = 10_000;

export type Mode = "local" | "remote";

export function getMode(): Mode {
  const explicit = process.env.ATLASENT_MODE?.toLowerCase();
  if (explicit === "remote") return "remote";
  if (explicit === "local") return "local";
  if (process.env.ATLASENT_API_KEY && process.env.ATLASENT_API_URL) return "remote";
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
// Remote (hosted AtlaSent v2 backend)
// ---------------------------------------------------------------------------

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `@atlasent/mcp-server/${VERSION}`,
  };
  const key = process.env.ATLASENT_API_KEY;
  if (key) headers["X-AtlaSent-Key"] = key;
  return headers;
}

function baseUrl(): string {
  return (process.env.ATLASENT_API_URL ?? "https://api.atlasent.com").replace(/\/+$/, "");
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
  permitId?: string;
  risk?: { level: string; score: number };
  id?: string;
  reason?: string;
  conditions?: string[];
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  const body: Record<string, unknown> = {
    actor: { id: ctx.actor_id, type: "service" },
    action: { type: ctx.action_type },
    target: { environment: ctx.environment },
  };
  if (ctx.approvals !== undefined) body.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) body.change_window = ctx.change_window;

  const data = await post<RawEvaluate>("/v1/evaluate", body);

  if (data.decision === "allow") {
    if (!data.permitId) throw new Error("Remote allowed the action but returned no permitId");
    const out: Decision = { decision: "allow", permit_token: data.permitId };
    if (data.id) out.audit_id = data.id;
    if (data.conditions?.length) out.conditions = data.conditions;
    return out;
  }

  if (data.decision === "require_approval") {
    return {
      decision: "hold",
      reason: data.reason ?? "Held for human review",
      ...(data.id && { audit_id: data.id }),
    };
  }

  return {
    decision: "deny",
    reason: data.reason ?? `Denied (decision=${data.decision})`,
    ...(data.id && { audit_id: data.id }),
  };
}

interface RawVerify {
  status: string;
  valid: boolean;
  reason?: string;
  evaluationId?: string;
}

async function verifyRemote(permitId: string, _ctx: ActionContext): Promise<VerifyResult> {
  // v2: permit ID is in the path; no body needed
  const res = await fetch(`${baseUrl()}/v1/permits/${encodeURIComponent(permitId)}/verify`, {
    method: "POST",
    headers: buildHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AtlaSent API ${res.status}: ${text}`);
  }
  const data = (await res.json()) as RawVerify;

  const outcome =
    data.status === "verified" || data.status === "expired" || data.status === "invalid"
      ? data.status
      : "error";

  return {
    outcome,
    valid: data.valid === true,
    ...(data.reason && { reason: data.reason }),
    ...(data.evaluationId && { audit_id: data.evaluationId }),
  };
}
