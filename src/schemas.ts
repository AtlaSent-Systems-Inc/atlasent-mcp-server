/**
 * Canonical wire schemas — mirror of `@atlasent/types` (packages/types) in the
 * atlasent umbrella repo.
 *
 * The MCP server is a thin gate over the hosted authorization engine. Any
 * shape that crosses an HTTP boundary (request body, response body) MUST
 * match these definitions exactly. Types diverge from the umbrella only
 * after a deliberate version bump there.
 *
 * Wire shapes are snake_case (HTTP). Domain shapes (camelCase) are not
 * needed inside the MCP server because tool args are translated directly
 * into the wire body in `engine.ts`.
 *
 * Source of truth:
 *   https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/packages/types/src/index.ts
 */

export type ISO8601 = string;
export type UUID = string;
export type SemVer = string;

/** Opaque single-use token issued by the server on `allow`. */
export type PermitToken = string;

// ─── Actor / Action / Target ──────────────────────────────────────────────

export type ActorType = "user" | "service" | "agent" | "system";

export interface Actor {
  id: string;
  type: ActorType;
  email?: string;
  name?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface Action {
  id: string;
  type: string;
  description?: string;
  isBulk?: boolean;
  bulkCount?: number;
  metadata?: Record<string, unknown>;
}

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type Environment = "production" | "staging" | "development";

export interface Target {
  id: string;
  type: string;
  sensitivity?: Sensitivity;
  environment?: Environment;
  metadata?: Record<string, unknown>;
}

// ─── Risk ────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  /** 0-100. */
  score: number;
  level: RiskLevel;
  factors: string[];
  mitigations?: string[];
}

// ─── Decision ────────────────────────────────────────────────────────────

/**
 * Canonical execution-time decision values.
 *
 *   allow     — proceed. A permit token is issued for exactly one action.
 *   deny      — do not proceed. No permit will be issued.
 *   hold      — do not proceed yet. An approval flow must resolve first.
 *   escalate  — do not proceed. A higher-authority reviewer must decide.
 *
 * Only `allow` permits execution. Every other value is a block.
 */
export type Decision = "allow" | "deny" | "hold" | "escalate";

/** True iff `decision === 'allow'`. */
export const isAllowed = (d: Decision): d is "allow" => d === "allow";

// ─── Wire: POST /v1/evaluate ─────────────────────────────────────────────

export interface EvaluateRequest {
  actor: Actor;
  action: Action;
  target: Target;
  context?: Record<string, unknown>;
}

export interface EvaluateResponse {
  decision: Decision;
  evaluation_id: UUID;
  risk: RiskAssessment;
  reason?: string;
  matched_rule_id?: UUID;
  /** Present iff `decision === 'allow'`. Single-use, short-lived. */
  permit_token?: PermitToken;
  permit_id?: UUID;
  permit_expires_at?: ISO8601;
  /** Tamper-evident hash chain entry written for this evaluation. */
  audit_hash?: string;
  /** Policy bundle that produced this decision. */
  bundle_id?: string;
  bundle_version?: number;
  evaluated_at: ISO8601;
}

// ─── Wire: POST /v1/verify-permit ─────────────────────────────────────────

export interface VerifyPermitRequest {
  permit_token: PermitToken;
  /** Optional execution context recorded on consumption. */
  execution_context?: Record<string, unknown>;
}

export interface VerifyPermitResponse {
  permit_id: UUID;
  evaluation_id: UUID;
  consumed: boolean;
  consumed_at: ISO8601;
  audit_hash: string;
}

// ─── API errors (JSON body for non-2xx) ───────────────────────────────────

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
