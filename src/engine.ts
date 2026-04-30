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
 * Wire contract: `POST /v1/evaluate` + `POST /v1/verify-permit`, snake_case
 * `{actor, action, target, context}` bodies — see `schemas.ts` and the
 * canonical types at
 * https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/packages/types/src/index.ts
 *
 * Fail-closed: every thrown error collapses to `{ decision: 'deny' }` /
 * `{ outcome: 'error', valid: false }`.
 */

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import { denyDecision } from "./decision.js";
import { authorizeLocal, verifyLocal } from "./localEngine.js";
import type {
  Actor,
  Action,
  Target,
  EvaluateRequest,
  EvaluateResponse,
  Environment,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./schemas.js";

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

// ──────────────────────────────────────────────────────────────────────────
// Remote (hosted AtlaSent backend) — canonical /v1/* contract
// ──────────────────────────────────────────────────────────────────────────

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

function normalizeEnvironment(env: string): Environment {
  return env === "production" || env === "staging" || env === "development" ? env : "production";
}

function randomId(): string {
  // Short id for action.id when the caller did not supply one.
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Translate the MCP-friendly ActionContext into the canonical wire body. */
function toEvaluateRequest(ctx: ActionContext): EvaluateRequest {
  const actor: Actor = { id: ctx.actor_id, type: "agent" };
  const action: Action = { id: randomId(), type: ctx.action_type };
  const target: Target = {
    id: ctx.action_type,
    type: "action",
    environment: normalizeEnvironment(ctx.environment),
  };
  const context: Record<string, unknown> = {};
  if (ctx.approvals !== undefined) context.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) context.change_window = ctx.change_window;
  return Object.keys(context).length > 0
    ? { actor, action, target, context }
    : { actor, action, target };
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  const data = await post<EvaluateResponse>("/v1/evaluate", toEvaluateRequest(ctx));

  if (data.decision === "allow") {
    if (!data.permit_token)
      throw new Error("Remote allowed the action but returned no permit_token");
    const out: Decision = { decision: "allow", permit_token: data.permit_token };
    if (data.audit_hash) out.audit_id = data.audit_hash;
    return out;
  }

  if (data.decision === "hold") {
    return {
      decision: "hold",
      reason: data.reason ?? "Held for human review",
      ...(data.audit_hash && { audit_id: data.audit_hash }),
    };
  }

  if (data.decision === "escalate") {
    return {
      decision: "escalate",
      reason: data.reason ?? "Escalated to higher-authority reviewer",
      ...(data.audit_hash && { audit_id: data.audit_hash }),
    };
  }

  // `deny` and any unknown decision string fail closed.
  return {
    decision: "deny",
    reason: data.reason ?? `Denied (decision=${data.decision})`,
    ...(data.audit_hash && { audit_id: data.audit_hash }),
  };
}

async function verifyRemote(token: string, ctx: ActionContext): Promise<VerifyResult> {
  const body: VerifyPermitRequest = {
    permit_token: token,
    execution_context: {
      action_type: ctx.action_type,
      actor_id: ctx.actor_id,
      environment: ctx.environment,
      ...(ctx.approvals !== undefined && { approvals: ctx.approvals }),
      ...(ctx.change_window !== undefined && { change_window: ctx.change_window }),
    },
  };

  const data = await post<VerifyPermitResponse>("/v1/verify-permit", body);

  if (data.consumed === true) {
    return {
      outcome: "verified",
      valid: true,
      ...(data.audit_hash && { audit_id: data.audit_hash }),
    };
  }

  return {
    outcome: "invalid",
    valid: false,
    reason: "Permit was not consumed by the server",
    ...(data.audit_hash && { audit_id: data.audit_hash }),
  };
}
