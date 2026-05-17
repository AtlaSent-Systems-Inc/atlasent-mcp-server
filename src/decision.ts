/**
 * Shared decision envelope for authorization checks.
 *
 * Every `authorize()` call returns a Decision. Every Decision serializes to
 * the same JSON shape, so clients can handle allow/deny/hold uniformly.
 */

export type ActionContext = {
  action_type: string;
  actor_id: string;
  environment: string;
  approvals?: string[];
  change_window?: string;
};

export type AllowDecision = {
  decision: "allow";
  permit_token: string;
  audit_id?: string;
  conditions?: string[];
};

export type DenyDecision = {
  decision: "deny";
  reason: string;
  audit_id?: string;
};

export type HoldDecision = {
  decision: "hold";
  reason: string;
  hold_id?: string;
  audit_id?: string;
};

export type Decision = AllowDecision | DenyDecision | HoldDecision;

/** Result of verifying a previously issued permit. */
export type VerifyResult = {
  outcome: "verified" | "expired" | "invalid" | "error";
  valid: boolean;
  reason?: string;
  verify_error_code?: string;
  audit_id?: string;
};

/**
 * Wrap a decision / verify result / REST result in the MCP tool-result
 * envelope. The same helper serves three caller shapes:
 *
 *   1. Decision (`{ decision: "allow" | "deny" | "hold", ... }`)
 *      from the local authorize() path. `isError` is set when decision !== "allow".
 *   2. VerifyResult (`{ valid, outcome, ... }`) from verify(). `isError`
 *      when `valid !== true`.
 *   3. Generic REST envelopes from the hosted-API tools — `listPolicies`,
 *      `getPolicy`, `createPolicy`, etc. return `unknown` (the API response
 *      shape), and rate-limit short-circuits return `{ error, reason }`.
 *      `isError` is set when an `error` field is present; otherwise the
 *      response is treated as success.
 *
 * Payload is accepted as `Record<string, unknown>` so all three shapes
 * flow through. Callers that hand us an arbitrary REST response (`unknown`)
 * should `as Record<string, unknown>` it — the envelope contract is "this
 * is a JSON object the host should display"; non-object payloads are not
 * a real use case here.
 */
export function toolResult(
  payload: unknown,
  extra?: Record<string, unknown>,
) {
  const obj = isObject(payload) ? payload : { value: payload };
  const body = { ...obj, ...(extra ?? {}) };
  const isError = computeIsError(obj);

  const result: { content: Array<{ type: "text"; text: string }>; isError?: true } = {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
  if (isError) result.isError = true;
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function computeIsError(payload: Record<string, unknown>): boolean {
  // Decision envelope: only "allow" is success.
  if (typeof payload.decision === "string") {
    return payload.decision !== "allow";
  }
  // VerifyResult envelope: explicit valid flag.
  if (typeof payload.valid === "boolean") {
    return payload.valid !== true;
  }
  // Error envelope from rate-limit short-circuits and similar.
  if (payload.error != null) {
    return true;
  }
  // Plain REST success response — no error signal.
  return false;
}

export function denyDecision(reason: string, audit_id?: string): DenyDecision {
  return audit_id ? { decision: "deny", reason, audit_id } : { decision: "deny", reason };
}
