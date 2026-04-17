/**
 * Local policy engine — used when no hosted AtlaSent backend is configured.
 *
 * This is intentionally small: a few deterministic rules that mirror the kind
 * of decisions the hosted engine will make. It lets developers run the MCP
 * server, drive the full evaluate → act → verify flow, and see allow / deny /
 * hold outcomes without any network credentials.
 *
 * Rules (fail-closed defaults):
 *   1. production action + no approvals     → deny
 *   2. destructive action + no change window → hold
 *   3. otherwise                              → allow
 */

import type { ActionContext, Decision, VerifyResult } from "./decision.js";

const DESTRUCTIVE_KEYWORDS = ["delete", "drop", "destroy", "truncate", "rm", "purge", "wipe"];
const PERMIT_TTL_MS = 5 * 60 * 1000;

function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isDestructive(action: string): boolean {
  const a = action.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((k) => a.includes(k));
}

export function authorizeLocal(ctx: ActionContext): Decision {
  const audit_id = shortId("aud_local");
  const hasApproval = (ctx.approvals?.length ?? 0) > 0;
  const hasWindow = !!ctx.change_window;
  const isProd = ctx.environment === "production";

  if (isProd && !hasApproval) {
    return {
      decision: "deny",
      reason: `Production action '${ctx.action_type}' requires at least one approval. Add an approval to the 'approvals' list and retry.`,
      audit_id,
    };
  }

  if (isDestructive(ctx.action_type) && !hasWindow) {
    return {
      decision: "hold",
      reason: `Destructive action '${ctx.action_type}' requires a scheduled change_window. Awaiting human review.`,
      hold_id: shortId("hold_local"),
      audit_id,
    };
  }

  return {
    decision: "allow",
    permit_token: shortId("pt_local"),
    audit_id,
  };
}

/**
 * Verify a locally-issued permit token.
 * Local tokens encode a base36 timestamp — we use that to check TTL.
 */
export function verifyLocal(token: string, _ctx: ActionContext): VerifyResult {
  const audit_id = shortId("aud_local");

  if (!token.startsWith("pt_local_")) {
    return { outcome: "invalid", valid: false, reason: "Token is not a local-mode permit", audit_id };
  }

  const parts = token.split("_");
  if (parts.length < 4) {
    return { outcome: "invalid", valid: false, reason: "Malformed local permit token", audit_id };
  }

  const issuedAt = parseInt(parts[2], 36);
  if (Number.isNaN(issuedAt)) {
    return { outcome: "invalid", valid: false, reason: "Unparseable timestamp in local permit", audit_id };
  }

  if (Date.now() - issuedAt > PERMIT_TTL_MS) {
    return {
      outcome: "expired",
      valid: false,
      reason: `Local permit expired (TTL ${PERMIT_TTL_MS / 1000}s)`,
      audit_id,
    };
  }

  return { outcome: "verified", valid: true, audit_id };
}
