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
 * Production safeguard: local-mode permits are unsigned and forgeable
 * (Date.now() + UUID slice, no HMAC — see src/localEngine.ts shortId()).
 * Local mode is intended for development and CI only. getMode() refuses
 * to resolve to local when NODE_ENV=production unless the operator has
 * explicitly opted in with ATLASENT_ALLOW_LOCAL_MODE_IN_PROD=true.
 *
 * Maturity classification (atlasent/MATURITY_DOCTRINE.md, adopted 2026-05-26):
 *   - local mode   — **Experimental**. UI/runtime exists but permits are
 *                    unsigned and forgeable. Dev/CI only. A stderr warning
 *                    is emitted once per process when local mode resolves.
 *   - remote mode  — **GA**. Hosted backend with signed permits and audit
 *                    chain.
 *
 * The hosted backend is a configuration swap, not a rewrite: every tool
 * handler calls `authorize(ctx)` and gets back the same Decision shape.
 */

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import { denyDecision } from "./decision.js";
import { authorizeLocal, verifyLocal } from "./localEngine.js";

const VERSION = "2.11.0";
const REQUEST_TIMEOUT_MS = 10_000;

// AbortSignal.timeout() is not available in all Node 22 environments;
// use AbortController + setTimeout for broad compatibility.
function makeAbortSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export type Mode = "local" | "remote";

// Module-level flag: emit the local-mode maturity warning at most once
// per process. getMode() is called on every authorize/verify, so without
// this gate the warning would flood stderr.
let LOCAL_MODE_WARNING_EMITTED = false;

function emitLocalModeWarning(): void {
  if (LOCAL_MODE_WARNING_EMITTED) return;
  if (process.env.NODE_ENV === "test") return;
  if (process.env.ATLASENT_SUPPRESS_LOCAL_MODE_WARNING === "true") return;
  LOCAL_MODE_WARNING_EMITTED = true;
  // eslint-disable-next-line no-console
  console.error(
    "[atlasent-mcp-server] WARNING: running in LOCAL mode. " +
      "Local-mode permits are unsigned and forgeable " +
      "(Date.now() + UUID, no HMAC). " +
      "Per atlasent/MATURITY_DOCTRINE.md, local mode is classified " +
      "Experimental and is intended for development and CI only. " +
      "For production-authoritative authorization, set ATLASENT_API_KEY " +
      "and ATLASENT_BASE_URL to use the hosted AtlaSent backend. " +
      "See SECURITY.md § 'Maturity classification' for details. " +
      "Set ATLASENT_SUPPRESS_LOCAL_MODE_WARNING=true to silence this warning " +
      "in dev/CI scripts.",
  );
}

export function getMode(): Mode {
  const explicit = process.env.ATLASENT_MODE?.toLowerCase();
  const requested: Mode =
    explicit === "remote"
      ? "remote"
      : explicit === "local"
        ? "local"
        : process.env.ATLASENT_API_KEY && process.env.ATLASENT_BASE_URL
          ? "remote"
          : "local";

  // Production safeguard (security): local-mode permits are unsigned
  // and forgeable (Date.now() + UUID slice, no HMAC; see
  // src/localEngine.ts shortId()). Refuse to run local mode under
  // NODE_ENV=production unless the operator has explicitly opted in
  // with ATLASENT_ALLOW_LOCAL_MODE_IN_PROD=true. Without this guard,
  // missing ATLASENT_API_KEY / ATLASENT_BASE_URL env vars in a
  // production deployment would silently fall through to local mode,
  // allowing anyone to mint valid-looking permits.
  if (
    requested === "local" &&
    process.env.NODE_ENV === "production" &&
    process.env.ATLASENT_ALLOW_LOCAL_MODE_IN_PROD !== "true"
  ) {
    throw new Error(
      "MCP server refuses to run in local mode with NODE_ENV=production. " +
        "Local-mode permits are unsigned and forgeable. Either set " +
        "ATLASENT_API_KEY and ATLASENT_BASE_URL to use the hosted AtlaSent " +
        "backend, or explicitly opt in (NOT RECOMMENDED) with " +
        "ATLASENT_ALLOW_LOCAL_MODE_IN_PROD=true.",
    );
  }

  // Emit the maturity warning at most once per process when local mode
  // is actually being used. This is the visibility companion to the
  // hard production refusal above: dev/CI usage is permitted, but the
  // operator should know they are running in Experimental mode.
  if (requested === "local") {
    emitLocalModeWarning();
  }

  return requested;
}

export async function authorize(ctx: ActionContext): Promise<Decision> {
  try {
    return getMode() === "remote" ? await authorizeRemote(ctx) : authorizeLocal(ctx);
  } catch (err) {
    return denyDecision([err instanceof Error ? err.message : String(err)]);
  }
}

export async function verify(token: string, ctx: ActionContext): Promise<VerifyResult> {
  try {
    return getMode() === "remote" ? await verifyRemote(token, ctx) : verifyLocal(token, ctx);
  } catch (err) {
    return {
      outcome: "error",
      valid: false,
      reasons: [err instanceof Error ? err.message : String(err)],
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
  return (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io").replace(/\/+$/, "");
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
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
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
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
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
//     envelope_hash?: string,
//     denial?: { reasons: string[], code: string } }
//
// `envelope_hash` is the sha-256 of the canonical ContextEnvelopeV1 the API
// records for the evaluation (see _shared/context-envelope-v1.ts in
// atlasent-api). When present, it is the canonical join key between this
// decision, the issued permit, the consumed payload, and any constrained-
// agent finding produced during the same evaluation. We surface it through
// the Decision so MCP tool hosts can stamp it into agent-side audit.
interface RawEvaluate {
  decision: string;
  permit_token?: string;
  reasons?: string[];
  request_id?: string;
  envelope_hash?: string;
  denial?: { reasons?: string[]; code?: string };
  conditions?: string[];
  hold_id?: string;
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  const context: Record<string, unknown> = { environment: ctx.environment };
  if (ctx.approvals !== undefined) context.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) context.change_window = ctx.change_window;
  if (ctx.tool_name !== undefined) context.tool_name = ctx.tool_name;

  const body: Record<string, unknown> = {
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    context,
    // state_snapshot is a top-level EvaluateBody field required when
    // requires_state_snapshot=true (all classes since backfill 20260603000019).
    state_snapshot: ctx.state_snapshot ?? { source: "atlasent-mcp", complete: true },
  };

  const data = await post<RawEvaluate>("/v1-evaluate", body);

  // Normalise request_id → audit_id (canonical API contract uses request_id).
  const audit_id = data.request_id;
  const envelope_hash = data.envelope_hash;

  if (data.decision === "allow") {
    if (!data.permit_token) throw new Error("Remote allowed the action but returned no permit_token");
    const out: Decision = { decision: "allow", permit_token: data.permit_token };
    if (audit_id) out.audit_id = audit_id;
    if (envelope_hash) out.envelope_hash = envelope_hash;
    if (data.conditions?.length) out.conditions = data.conditions;
    return out;
  }

  if (data.decision === "hold" || data.decision === "escalate") {
    const reasons = data.denial?.reasons ?? data.reasons ?? ["Held for human review"];
    return {
      decision: "hold",
      reasons,
      ...(data.denial?.code && { deny_code: data.denial.code }),
      ...(data.hold_id && { hold_id: data.hold_id }),
      ...(audit_id && { audit_id }),
      ...(envelope_hash && { envelope_hash }),
    };
  }

  // Anything else (including "deny" or an unknown decision) is fail-closed.
  const reasons = data.denial?.reasons ?? data.reasons ?? [`Denied (decision=${data.decision})`];
  const deny_code = data.denial?.code;
  const out: Decision = {
    decision: "deny",
    reasons,
    ...(deny_code && { deny_code }),
    // A human-approval gate is not a terminal refusal — flag it so the host
    // can route to a person (e.g. create_approval_request) instead of giving
    // up. The action still does not run now (fail-closed preserved).
    ...(deny_code === "HUMAN_APPROVAL_REQUIRED" && { requires_human_approval: true }),
    ...(audit_id && { audit_id }),
    ...(envelope_hash && { envelope_hash }),
  };
  return out;
}

// Canonical verify-permit response shape (v1-verify-permit/handler.ts):
//   { valid: boolean, outcome: "allow"|"deny",
//     verify_error_code?: string, reasons?: string[] }
interface RawVerify {
  valid: boolean;
  outcome: "allow" | "deny";
  verify_error_code?: string;
  reasons?: string[];
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
    ...(data.reasons?.length && { reasons: data.reasons }),
    ...(data.verify_error_code && { verify_error_code: data.verify_error_code }),
  };
}

// ---------------------------------------------------------------------------
// New standalone API calls (atlasent_evaluate, list_policies, get_policy,
// list_audit_events) — these speak to /v1/* REST endpoints and return the
// raw API response; no local-engine fallback (they require remote mode).
// ---------------------------------------------------------------------------

export interface RiskEnvelopeFactor {
  score: number;
  weight: number;
  contribution: number;
}

export interface RiskEnvelope {
  weighted_score: number;
  engine_decision: string;
  envelope_decision: string;
  promoted: boolean;
  hard_blocks: string[];
  factors?: Record<string, RiskEnvelopeFactor>;
}

export interface EvaluateParams {
  subject: string;
  action: string;
  resource: string;
  org_id: string;
  context?: Record<string, unknown>;
  explain?: boolean;
  state_snapshot?: Record<string, unknown>;
}

export interface EvaluateResponse {
  decision: string;
  evaluationId?: string;
  permit?: string;
  permitToken?: string;
  reasons?: string[];
  risk_envelope?: RiskEnvelope;
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
  if (params.explain !== undefined) body.explain = params.explain;
  body.state_snapshot = params.state_snapshot ?? { source: "atlasent-mcp", complete: true };
  return post<EvaluateResponse>("/v1-evaluate", body);
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

export interface CreatePolicyParams {
  org_id: string;
  policy_id: string;
  title: string;
  policy_type: string;
  rules: unknown[];
  description?: string;
  version?: string;
  priority?: number;
  applies_to?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  effective_at?: string;
  expires_at?: string;
}

export async function createPolicy(params: CreatePolicyParams): Promise<unknown> {
  return post("/v1/policies", params);
}

export interface UpdatePolicyParams {
  policy_id: string;
  org_id: string;
  title?: string;
  description?: string;
  policy_type?: string;
  rules?: unknown[];
  version?: string;
  priority?: number;
  applies_to?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  status?: string;
  effective_at?: string;
  expires_at?: string;
}

export async function updatePolicy(params: UpdatePolicyParams): Promise<unknown> {
  const { policy_id, ...patchBody } = params;
  return patch(`/v1/policies/${encodeURIComponent(policy_id)}`, patchBody);
}

export interface RevokePermitParams {
  permitToken: string;
  org_id: string;
  reasons?: string[];
}

export async function revokePermit(params: RevokePermitParams): Promise<unknown> {
  return post(`/v1/permits/${encodeURIComponent(params.permitToken)}/revoke`, {
    org_id: params.org_id,
    ...(params.reasons !== undefined ? { reasons: params.reasons } : {}),
  });
}

export interface ListPermitsParams {
  org_id: string;
  status?: string;
  actor_id?: string;
  action_type?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export async function listPermits(params: ListPermitsParams): Promise<unknown> {
  return get("/v1/permits", {
    org_id: params.org_id,
    status: params.status,
    actor_id: params.actor_id,
    action_type: params.action_type,
    from: params.from,
    to: params.to,
    limit: params.limit !== undefined ? String(params.limit) : undefined,
    cursor: params.cursor,
  });
}

// ---------------------------------------------------------------------------
// Permit issuance + v1 verification
// ---------------------------------------------------------------------------

export interface IssuePermitParams {
  subject: string;
  action: string;
  resource: string;
  org_id: string;
  ttl_seconds?: number;
  context?: Record<string, unknown>;
}

export async function issuePermit(params: IssuePermitParams): Promise<unknown> {
  const body: Record<string, unknown> = {
    subject: params.subject,
    action: params.action,
    resource: params.resource,
    org_id: params.org_id,
  };
  if (params.ttl_seconds !== undefined) body.ttl_seconds = params.ttl_seconds;
  if (params.context !== undefined) body.context = params.context;
  return post("/v1/permits/issue", body);
}

export interface VerifyPermitV1Params {
  permit_token: string;
  org_id: string;
  action?: string;
  resource?: string;
}

export async function verifyPermitV1(params: VerifyPermitV1Params): Promise<unknown> {
  const body: Record<string, unknown> = {
    permit_token: params.permit_token,
    org_id: params.org_id,
  };
  if (params.action !== undefined) body.action = params.action;
  if (params.resource !== undefined) body.resource = params.resource;
  return post("/v1/permits/verify", body);
}

// ---------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------

export interface CreateApprovalRequestParams {
  subject: string;
  action: string;
  resource: string;
  org_id: string;
  justification?: string;
  context?: Record<string, unknown>;
}

export async function createApprovalRequest(
  params: CreateApprovalRequestParams,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    subject: params.subject,
    action: params.action,
    resource: params.resource,
    org_id: params.org_id,
  };
  if (params.justification !== undefined) body.justification = params.justification;
  if (params.context !== undefined) body.context = params.context;
  return post("/v1/approval-requests", body);
}

export interface ResolveApprovalRequestParams {
  approval_request_id: string;
  org_id: string;
  resolution: "approve" | "deny";
  resolver_id: string;
  comment?: string;
}

export async function resolveApprovalRequest(
  params: ResolveApprovalRequestParams,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    org_id: params.org_id,
    resolution: params.resolution,
    resolver_id: params.resolver_id,
  };
  if (params.comment !== undefined) body.comment = params.comment;
  return post(
    `/v1/approval-requests/${encodeURIComponent(params.approval_request_id)}/resolve`,
    body,
  );
}

// ---------------------------------------------------------------------------
// Policy deletion
// ---------------------------------------------------------------------------

export interface DeletePolicyParams {
  policy_id: string;
  org_id: string;
}

async function del<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  let url = `${baseUrl()}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method: "DELETE",
    headers: buildHeaders(),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  // DELETE responses may have no body (204 No Content) or a JSON body
  const text = await res.text().catch(() => "");
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function deletePolicy(params: DeletePolicyParams): Promise<unknown> {
  return del(`/v1/policies/${encodeURIComponent(params.policy_id)}`, {
    org_id: params.org_id,
  });
}

// ---------------------------------------------------------------------------
// Execution evaluation recording
// ---------------------------------------------------------------------------

export interface RecordExecutionEvaluationParams {
  evaluation_id: string;
  org_id: string;
  outcome: "success" | "failure" | "skipped";
  executed_at?: string;
  details?: Record<string, unknown>;
}

export async function recordExecutionEvaluation(
  params: RecordExecutionEvaluationParams,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    org_id: params.org_id,
    outcome: params.outcome,
  };
  if (params.executed_at !== undefined) body.executed_at = params.executed_at;
  if (params.details !== undefined) body.details = params.details;
  return post(
    `/v1/evaluations/${encodeURIComponent(params.evaluation_id)}/execution`,
    body,
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface CreateWebhookParams {
  org_id: string;
  url: string;
  events: string[];
  description?: string;
  secret?: string;
}

export async function createWebhook(params: CreateWebhookParams): Promise<unknown> {
  const body: Record<string, unknown> = {
    org_id: params.org_id,
    url: params.url,
    events: params.events,
  };
  if (params.description !== undefined) body.description = params.description;
  if (params.secret !== undefined) body.secret = params.secret;
  return post("/v1/webhooks", body);
}

export interface DeleteWebhookParams {
  webhook_id: string;
  org_id: string;
}

export async function deleteWebhook(params: DeleteWebhookParams): Promise<unknown> {
  return del(`/v1/webhooks/${encodeURIComponent(params.webhook_id)}`, {
    org_id: params.org_id,
  });
}

// ---------------------------------------------------------------------------
// HTTP PUT helper
// ---------------------------------------------------------------------------

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PUT",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// SCIM 2.0 provisioning
// ---------------------------------------------------------------------------

export async function listScimUsers(
  orgId: string,
  filter?: string,
  startIndex?: number,
  count?: number,
): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users`, {
    filter,
    startIndex: startIndex !== undefined ? String(startIndex) : undefined,
    count: count !== undefined ? String(count) : undefined,
  });
}

export async function getScimUser(orgId: string, userId: string): Promise<unknown> {
  return get(
    `/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users/${encodeURIComponent(userId)}`,
  );
}

export async function createScimUser(
  orgId: string,
  attributes: Record<string, unknown>,
): Promise<unknown> {
  return post(`/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users`, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    ...attributes,
  });
}

export async function patchScimUser(
  orgId: string,
  userId: string,
  operations: Array<{ op: string; path?: string; value?: unknown }>,
): Promise<unknown> {
  return patch(
    `/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users/${encodeURIComponent(userId)}`,
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: operations,
    },
  );
}

export async function deleteScimUser(orgId: string, userId: string): Promise<unknown> {
  return del(
    `/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users/${encodeURIComponent(userId)}`,
  );
}

export async function listScimGroups(
  orgId: string,
  filter?: string,
  startIndex?: number,
  count?: number,
): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Groups`, {
    filter,
    startIndex: startIndex !== undefined ? String(startIndex) : undefined,
    count: count !== undefined ? String(count) : undefined,
  });
}

// ---------------------------------------------------------------------------
// SIEM export configuration
// ---------------------------------------------------------------------------

export async function getSiemConfig(orgId: string): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/siem-config`);
}

export async function upsertSiemConfig(
  orgId: string,
  config: Record<string, unknown>,
): Promise<unknown> {
  return put(`/v1/orgs/${encodeURIComponent(orgId)}/siem-config`, config);
}

export async function testSiemDelivery(orgId: string): Promise<unknown> {
  return post(`/v1/orgs/${encodeURIComponent(orgId)}/siem-exports/test`, {});
}

// ---------------------------------------------------------------------------
// Evidence exports (compliance bundles)
// ---------------------------------------------------------------------------

export async function listEvidenceExports(orgId: string, regime?: string): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/evidence-exports`, {
    regime,
  });
}

export async function getEvidenceExport(orgId: string, exportId: string): Promise<unknown> {
  return get(
    `/v1/orgs/${encodeURIComponent(orgId)}/evidence-exports/${encodeURIComponent(exportId)}`,
  );
}

export async function createEvidenceExport(
  orgId: string,
  payload: { regime: string; date_from?: string; date_to?: string },
): Promise<unknown> {
  return post(`/v1/orgs/${encodeURIComponent(orgId)}/evidence-exports`, payload);
}
