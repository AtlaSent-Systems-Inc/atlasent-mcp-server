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
  audit_id?: string;
};

/**
 * Wrap a decision / verify result in the MCP tool-result envelope.
 * Non-allow decisions and non-verified outcomes set `isError: true`
 * so hosts surface them as errors in the tool-call UI.
 */
export function toolResult(
  payload: Decision | VerifyResult | (Decision & { result?: unknown }),
  extra?: Record<string, unknown>,
) {
  const body = { ...payload, ...(extra ?? {}) };
  const isError =
    "decision" in payload
      ? payload.decision !== "allow"
      : payload.valid !== true;

  const result: { content: Array<{ type: "text"; text: string }>; isError?: true } = {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
  if (isError) result.isError = true;
  return result;
}

export function denyDecision(reason: string, audit_id?: string): DenyDecision {
  return audit_id ? { decision: "deny", reason, audit_id } : { decision: "deny", reason };
}
