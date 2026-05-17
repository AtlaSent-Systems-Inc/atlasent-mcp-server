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

import { randomUUID } from "node:crypto";

import type { ActionContext, Decision, VerifyResult } from "./decision.js";

const DESTRUCTIVE_KEYWORDS = ["delete", "drop", "destroy", "truncate", "rm", "purge", "wipe"];
const PERMIT_TTL_MS = 5 * 60 * 1000;

// In-memory single-use tracking. Local mode is single-process, so a
// Set is sufficient — production parity for "permits are consumed on
// verify" lives in the hosted backend. Without this, the same local
// token verified twice would both succeed, hiding replay bugs that
// only surface in remote mode.
const CONSUMED_TOKENS = new Set<string>();

// Cap the consumed-tokens set to bound memory in long-running dev
// sessions. Any entry older than this is no longer reachable as a
// valid permit anyway (PERMIT_TTL_MS is shorter), so dropping it on
// overflow doesn't change correctness.
const CONSUMED_CAP = 10_000;

function rememberConsumed(token: string): void {
  if (CONSUMED_TOKENS.size >= CONSUMED_CAP) {
    // Drop the oldest insertion order entry — Set preserves it.
    const first = CONSUMED_TOKENS.values().next().value;
    if (first) CONSUMED_TOKENS.delete(first);
  }
  CONSUMED_TOKENS.add(token);
}

function shortId(prefix: string): string {
  // randomUUID is CSPRNG-backed; the timestamp prefix is kept so
  // verifyLocal can still TTL-check based on issue time without a
  // separate side-table.
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
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
      reasons: [
        `Production action '${ctx.action_type}' requires at least one approval. Add an approval to the 'approvals' list and retry.`,
      ],
      audit_id,
    };
  }

  if (isDestructive(ctx.action_type) && !hasWindow) {
    return {
      decision: "hold",
      reasons: [
        `Destructive action '${ctx.action_type}' requires a scheduled change_window. Awaiting human review.`,
      ],
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
 * Tokens are single-use: a successful verify marks the token consumed,
 * so a second verify of the same token returns `invalid` (mirrors the
 * hosted backend's PERMIT_ALREADY_USED behaviour).
 */
export function verifyLocal(token: string, _ctx: ActionContext): VerifyResult {
  const audit_id = shortId("aud_local");

  if (!token.startsWith("pt_local_")) {
    return { outcome: "invalid", valid: false, reasons: ["Token is not a local-mode permit"], audit_id };
  }

  const parts = token.split("_");
  if (parts.length < 4) {
    return { outcome: "invalid", valid: false, reasons: ["Malformed local permit token"], audit_id };
  }

  const issuedAt = parseInt(parts[2], 36);
  if (Number.isNaN(issuedAt)) {
    return { outcome: "invalid", valid: false, reasons: ["Unparseable timestamp in local permit"], audit_id };
  }

  if (Date.now() - issuedAt > PERMIT_TTL_MS) {
    return {
      outcome: "expired",
      valid: false,
      reasons: [`Local permit expired (TTL ${PERMIT_TTL_MS / 1000}s)`],
      audit_id,
    };
  }

  if (CONSUMED_TOKENS.has(token)) {
    return {
      outcome: "invalid",
      valid: false,
      reasons: ["Local permit already used"],
      audit_id,
    };
  }

  rememberConsumed(token);
  return { outcome: "verified", valid: true, audit_id };
}

// Test-only hook so the unit suite can guarantee a clean slate between
// cases. Not exported from the package (no entry in dist's barrel).
export function _resetLocalEngineForTests(): void {
  CONSUMED_TOKENS.clear();
}
