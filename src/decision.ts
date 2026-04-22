/**
 * Shared decision envelope for authorization checks.
 *
 * Every `authorize()` call returns a Decision. Every Decision serializes to
 * the same JSON shape so clients can handle allow / deny / hold uniformly,
 * and so demo audiences can distinguish "tool was blocked by AtlaSent" from
 * "tool tried to run and failed."
 */

/**
 * Canonical AtlaSent payload:
 *
 *   action_type  — what the agent wants to do (deploy, send_email, write, ...)
 *   actor_id     — who is acting (agent id, user id, service id)
 *   context      — free-form bag of attributes the policy may inspect
 *                  (environment, recipient, sensitivity, payload_preview, ...)
 *
 * `environment`, `approvals`, and `change_window` are surfaced as first-class
 * fields because the hosted AtlaSent API treats them specially; everything
 * else tool-specific belongs in `context`.
 */
export type ActionContext = {
  action_type: string;
  actor_id: string;
  environment: string;
  approvals?: string[];
  change_window?: string;
  context?: Record<string, unknown>;
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
 *
 * We emit TWO content blocks so that both humans and machines can tell
 * "blocked by authorization" apart from "tool ran and failed":
 *
 *   content[0] — a human-readable banner, prefixed `[BLOCKED BY ATLASENT]`,
 *                `[ALLOWED BY ATLASENT]`, or `[HELD BY ATLASENT]`.
 *   content[1] — the structured JSON payload (stable shape for parsers).
 *
 * `isError` is set only when the action was not allowed / verified — MCP
 * hosts surface it as an error in the tool-call UI.
 */
export function toolResult(
  payload: Decision | VerifyResult | (Decision & { result?: unknown }),
  extra?: Record<string, unknown>,
) {
  const body = { ...payload, ...(extra ?? {}) };
  const banner = bannerFor(payload);
  const isError =
    "decision" in payload
      ? payload.decision !== "allow"
      : payload.valid !== true;

  const result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: true;
  } = {
    content: [
      { type: "text" as const, text: banner },
      { type: "text" as const, text: JSON.stringify(body) },
    ],
  };
  if (isError) result.isError = true;
  return result;
}

/**
 * Wrap a tool-execution failure (the action was authorized, but running it
 * threw). This is intentionally NOT an AtlaSent decision — the banner and
 * payload make it obvious the block was not a policy block.
 */
export function toolError(message: string, extra?: Record<string, unknown>) {
  const body = { error: message, phase: "execution", ...(extra ?? {}) };
  return {
    content: [
      { type: "text" as const, text: `[TOOL EXECUTION FAILED] ${message}` },
      { type: "text" as const, text: JSON.stringify(body) },
    ],
    isError: true as const,
  };
}

export function denyDecision(reason: string, audit_id?: string): DenyDecision {
  return audit_id ? { decision: "deny", reason, audit_id } : { decision: "deny", reason };
}

function bannerFor(
  payload: Decision | VerifyResult | (Decision & { result?: unknown }),
): string {
  if ("decision" in payload) {
    switch (payload.decision) {
      case "allow":
        return "[ALLOWED BY ATLASENT] Action authorized; tool executed.";
      case "deny":
        return `[BLOCKED BY ATLASENT] ${payload.reason} — tool did NOT execute.`;
      case "hold":
        return `[HELD BY ATLASENT] ${payload.reason} — tool did NOT execute; awaiting human review.`;
    }
  }
  if (payload.outcome === "verified" && payload.valid) {
    return "[PERMIT VERIFIED] Audit loop closed.";
  }
  return `[PERMIT NOT VERIFIED] outcome=${payload.outcome}${payload.reason ? ` — ${payload.reason}` : ""}`;
}
