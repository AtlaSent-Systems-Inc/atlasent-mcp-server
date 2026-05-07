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

function handleHttpError(status: number, body: string): never {
  if (status === 401) throw new Error("Authentication failed — check your ATLASENT_API_KEY");
  if (status === 403) throw new Error("Permission denied — your key lacks the required scope");
  if (status === 429) throw new Error("Rate limited — back off and retry");
  // Try to surface { error, message } from the body
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const errMsg = parsed.message ?? parsed.error ?? body;
    throw new Error(`AtlaSent API ${status}: ${errMsg}`);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`AtlaSent API ${status}: ${body}`);
    throw e;
  }
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
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  let url = `${baseUrl()}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

// Canonical evaluate response shape (v1-evaluate/handler.ts):
//   { decision: "allow"|"deny"|"hold"|"escalate",
//     permit_token?: string, request_id?: string, expires_at?: string,
//     denial?: { reason: string, code: string } }
interface RawEvaluate {
  decision: string;
  permit_token?: string;
  reason?: string;
  request_id?: string;
  denial?: { reason?: string; code?: string };
  conditions?: string[];
  hold_id?: string;
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  const context: Record<string, unknown> = { environment: ctx.environment };
  if (ctx.approvals !== undefined) context.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) context.change_window = ctx.change_window;

  const body: Record<string, unknown> = {
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    context,
  };

  const data = await post<RawEvaluate>("/v1-evaluate", body);

  // Normalise request_id → audit_id (canonical API contract uses request_id).
  const audit_id = data.request_id;

  if (data.decision === "allow") {
    if (!data.permit_token) throw new Error("Remote allowed the action but returned no permit_token");
    const out: Decision = { decision: "allow", permit_token: data.permit_token };
    if (audit_id) out.audit_id = audit_id;
    if (data.conditions?.length) out.conditions = data.conditions;
    return out;
  }

  if (data.decision === "hold" || data.decision === "escalate") {
    const reason = data.denial?.reason ?? data.reason ?? "Held for human review";
    return {
      decision: "hold",
      reason,
      ...(data.hold_id && { hold_id: data.hold_id }),
      ...(audit_id && { audit_id }),
    };
  }

  // Anything else (including "deny" or an unknown decision) is fail-closed.
  const reason = data.denial?.reason ?? data.reason ?? `Denied (decision=${data.decision})`;
  return {
    decision: "deny",
    reason,
    ...(audit_id && { audit_id }),
  };
}

// Canonical verify-permit response shape (v1-verify-permit/handler.ts):
//   { valid: boolean, outcome: "allow"|"deny",
//     verify_error_code?: string, reason?: string }
interface RawVerify {
  valid: boolean;
  outcome: "allow" | "deny";
  verify_error_code?: string;
  reason?: string;
}

async function verifyRemote(token: string, ctx: ActionContext): Promise<VerifyResult> {
  const body: Record<string, unknown> = {
    permit_token: token,
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
  };

  const data = await post<RawVerify>("/v1-verify-permit", body);

  // Map the canonical "allow"|"deny" outcome to the internal VerifyResult
  // outcome vocabulary used across both local and remote paths.
  // verify_error_code refines the deny outcome: PERMIT_EXPIRED → "expired",
  // RATE_LIMITED → "error", everything else → "invalid".
  let outcome: VerifyResult["outcome"];
  if (data.outcome === "allow") {
    outcome = "verified";
  } else {
    switch (data.verify_error_code) {
      case "PERMIT_EXPIRED":
        outcome = "expired";
        break;
      case "RATE_LIMITED":
        outcome = "error";
        break;
      default:
        outcome = "invalid";
    }
  }

  return {
    outcome,
    valid: data.valid === true,
    ...(data.reason && { reason: data.reason }),
    ...(data.verify_error_code && { verify_error_code: data.verify_error_code }),
  };
}

// ---------------------------------------------------------------------------
// New standalone API calls (atlasent_evaluate, list_policies, get_policy,
// list_audit_events) — these speak to /v1/* REST endpoints and return the
// raw API response; no local-engine fallback (they require remote mode).
// ---------------------------------------------------------------------------

export interface EvaluateParams {
  subject: string;
  action: string;
  resource: string;
  org_id: string;
  context?: Record<string, unknown>;
}

export interface EvaluateResponse {
  decision: string;
  permit_token?: string;
  evaluation_id?: string;
  reason?: string;
  [key: string]: unknown;
}

export async function evaluateAction(params: EvaluateParams): Promise<EvaluateResponse> {
  const body: Record<string, unknown> = {
    subject: params.subject,
    action: params.action,
    resource: params.resource,
    org_id: params.org_id,
  };
  if (params.context !== undefined) body.context = params.context;
  return post<EvaluateResponse>("/v1/evaluate", body);
}

export interface ListPoliciesParams {
  org_id: string;
  status?: string;
}

export async function listPolicies(params: ListPoliciesParams): Promise<unknown> {
  return get("/v1/policies", {
    org_id: params.org_id,
    status: params.status,
  });
}

export interface GetPolicyParams {
  policy_id: string;
  org_id: string;
}

export async function getPolicy(params: GetPolicyParams): Promise<unknown> {
  return get(`/v1/policies/${encodeURIComponent(params.policy_id)}`, {
    org_id: params.org_id,
  });
}

export interface ListAuditEventsParams {
  org_id: string;
  evaluation_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listAuditEvents(params: ListAuditEventsParams): Promise<unknown> {
  return get("/v1/audit/events", {
    org_id: params.org_id,
    evaluation_id: params.evaluation_id,
    from: params.from,
    to: params.to,
    limit: params.limit !== undefined ? String(params.limit) : undefined,
  });
}
