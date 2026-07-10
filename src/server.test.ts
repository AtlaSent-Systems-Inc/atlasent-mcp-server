import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVAL_ARGS = {
  action_type: "production.deploy",
  actor_id: "user-1",
  environment: "production",
};

function mockFetch(response: object, status = 200) {
  const fn = async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  return mock.fn(fn);
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function setup() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

function forceLocalMode(): void {
  process.env.ATLASENT_MODE = "local";
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_ANON_KEY;
  delete process.env.ATLASENT_BASE_URL;
}

function forceRemoteMode(): void {
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
}

function clearMode(): void {
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_ANON_KEY;
  delete process.env.ATLASENT_BASE_URL;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetRateLimitForTests();
  delete process.env.ATLASENT_MCP_RATE_LIMIT;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMode();
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("exposes evaluate, verify_permit, deploy_service, all write tools, v2 tools, and compliance tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "atlasent_atlas_lookup",
      "atlasent_create_approval_request",
      "atlasent_create_evidence_export",
      "atlasent_create_policy",
      "atlasent_create_scim_user",
      "atlasent_create_webhook",
      "atlasent_delete_policy",
      "atlasent_delete_scim_user",
      "atlasent_delete_webhook",
      "atlasent_evaluate",
      "atlasent_evaluate_many",
      "atlasent_evaluate_stream",
      "atlasent_get_evidence_export",
      "atlasent_get_policy",
      "atlasent_get_scim_user",
      "atlasent_get_siem_config",
      "atlasent_list_audit_events",
      "atlasent_list_evidence_exports",
      "atlasent_list_permits",
      "atlasent_list_policies",
      "atlasent_list_scim_groups",
      "atlasent_list_scim_users",
      "atlasent_lookup_action",
      "atlasent_patch_scim_user",
      "atlasent_permit",
      "atlasent_query",
      "atlasent_record_execution_evaluation",
      "atlasent_resolve_approval_request",
      "atlasent_revoke_permit",
      "atlasent_test_siem_delivery",
      "atlasent_trajectory_verify",
      "atlasent_update_policy",
      "atlasent_upsert_siem_config",
      "atlasent_verify_permit",
      "atlasent_vqp_audit_summary",
      "atlasent_vqp_drift_events",
      "atlasent_vqp_generate",
      "atlasent_vqp_verify",
      "deploy_service",
      "evaluate",
      "verify_permit",
    ]);
  });

  it("deploy_service requires service_name, environment, actor_id", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const deploy = tools.find((t) => t.name === "deploy_service")!;
    const required = (deploy.inputSchema as { required?: string[] }).required ?? [];
    for (const f of ["service_name", "environment", "actor_id"]) {
      assert.ok(required.includes(f), `missing required field: ${f}`);
    }
  });
});

// ---------------------------------------------------------------------------
// atlasent_atlas_lookup — Knowledge Atlas (read-only, no network)
// ---------------------------------------------------------------------------

describe("atlasent_atlas_lookup", () => {
  it("lists every concept when called with no arguments", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: {} });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.ok((body.result_count as number) >= 17, "expected the full concept index");
    const ids = (body.concepts as Array<{ id: string }>).map((c) => c.id);
    for (const id of ["permit", "policy", "gate", "audit-chain", "caller", "trust-root"]) {
      assert.ok(ids.includes(id), `index missing concept: ${id}`);
    }
  });

  it("returns a concept with resolved relationships for an exact id", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: { id: "permit" } });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.equal(body.result_count, 1);
    const c = (body.concepts as Array<Record<string, unknown>>)[0];
    assert.equal(c.id, "permit");
    assert.match(String(c.source_of_truth), /canon\/010/);
    // relationships are resolved to { id, term } / surfaces, not bare ids
    const usedBy = c.used_by as Array<{ id: string; term: string }>;
    assert.ok(usedBy.some((u) => u.id === "verification" && typeof u.term === "string"));
    assert.ok((c.realized_by as unknown[]).length > 0, "permit should be realized by surfaces");
  });

  it("substring query matches across term/definition", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: { query: "audit" } });
    const body = parseResult(result);
    assert.equal(body.found, true);
    const ids = (body.concepts as Array<{ id: string }>).map((c) => c.id);
    assert.ok(ids.includes("audit-chain"), "query 'audit' should match audit-chain");
  });

  it("reports found=false for an unknown id", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: { id: "does-not-exist" } });
    const body = parseResult(result);
    assert.equal(body.found, false);
    assert.equal(body.result_count, 0);
  });
});

// ---------------------------------------------------------------------------
// evaluate — local mode
// ---------------------------------------------------------------------------

describe("evaluate (local mode)", () => {
  it("allows staging actions by default", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, environment: "staging" },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.ok((data.permit_token as string).startsWith("pt_local_"));
    assert.equal(result.isError, undefined);
  });

  it("denies production actions with no approvals", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok(Array.isArray(data.reasons), "reasons must be an array");
    assert.ok((data.reasons as string[]).some((r) => r.toLowerCase().includes("approval")));
    assert.equal(result.isError, true);
  });

  it("allows production actions with approvals", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ticket-42"] },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(result.isError, undefined);
  });

  it("holds destructive actions without a change_window", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "delete_table",
        actor_id: "user-1",
        environment: "staging",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.ok((data.hold_id as string).startsWith("hold_local_"));
    assert.equal(result.isError, true);
  });

  it("allows destructive actions with a change_window", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "delete_table",
        actor_id: "user-1",
        environment: "staging",
        change_window: "2025-01-15T02:00:00Z/PT4H",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// evaluate — remote mode
// ---------------------------------------------------------------------------

describe("evaluate (remote mode)", () => {
  it("returns decision and permit_token on API success", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "allow",
      permit_token: "pt_xyz",
      request_id: "req_1",
      expires_at: "2026-01-01T01:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.permit_token, "pt_xyz");
    assert.equal(data.audit_id, "req_1");
  });

  it("surfaces envelope_hash on allow when the API returns one", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "allow",
      permit_token: "pt_envelope_1",
      request_id: "req_env_1",
      envelope_hash: "sha256:a1b2c3d4e5f6",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.envelope_hash, "sha256:a1b2c3d4e5f6");
  });

  it("surfaces envelope_hash on hold when the API returns one", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      denial: { reasons: ["needs witness"], code: "REQUIRES_WITNESS" },
      request_id: "req_env_hold",
      envelope_hash: "sha256:deadbeef",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.equal(data.envelope_hash, "sha256:deadbeef");
  });

  it("omits envelope_hash when the API does not return one", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "allow",
      permit_token: "pt_no_env",
      request_id: "req_no_env",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.envelope_hash, undefined);
  });

  it("normalizes escalate to hold", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      denial: { reasons: ["needs SRE review"], code: "REQUIRES_OVERRIDE" },
      request_id: "req_2",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.ok(Array.isArray(data.reasons));
    assert.equal((data.reasons as string[])[0], "needs SRE review");
    assert.equal(data.audit_id, "req_2");
    assert.equal(result.isError, true);
  });

  it("surfaces deny_code and flags INSUFFICIENT_APPROVALS for human routing", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "deny",
      denial: { reasons: ["a human must approve this action class"], code: "INSUFFICIENT_APPROVALS" },
      request_id: "req_hil",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.deny_code, "INSUFFICIENT_APPROVALS");
    assert.equal(data.requires_human_approval, true);
    // Fail-closed is preserved — a deny is still an error envelope.
    assert.equal(result.isError, true);
  });

  it("surfaces deny_code without the human-approval flag for other codes", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "deny",
      denial: { reasons: ["outside change window"], code: "OUTSIDE_CHANGE_WINDOW" },
      request_id: "req_ccw",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.deny_code, "OUTSIDE_CHANGE_WINDOW");
    assert.equal(data.requires_human_approval, undefined);
  });

  it("sends flat handler.ts body and correct auth headers", async () => {
    forceRemoteMode();
    process.env.ATLASENT_ANON_KEY = "test-anon";
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_1" });
    globalThis.fetch = fetcher;
    const { client } = await setup();
    await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["t-1"], change_window: "win-1" },
    });

    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    assert.equal(headers["x-anon-key"], "test-anon");
    assert.ok(headers["User-Agent"].startsWith("@atlasent/mcp-server/"));

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    assert.equal(body.action_type, "production.deploy");
    assert.equal(body.actor_id, "user-1");
    assert.deepEqual(body.context, {
      environment: "production",
      approvals: ["t-1"],
      change_window: "win-1",
    });
    // state_snapshot must be a top-level field (not inside context).
    assert.deepEqual(body.state_snapshot, { source: "atlasent-mcp", complete: true });
    // No top-level `environment` — handler.ts derives it from the API key.
    assert.equal(body.environment, undefined);
  });

  it("denies on HTTP 500 (fail-closed)", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "internal" }, 500);
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);
  });

  it("denies on network error (fail-closed)", async () => {
    forceRemoteMode();
    const fn = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reasons as string[])[0].includes("ECONNREFUSED"));
  });

  it("denies when remote allows but returns no permit_token", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ decision: "allow" });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reasons as string[])[0].includes("permit_token"));
  });
});

// ---------------------------------------------------------------------------
// verify_permit
// ---------------------------------------------------------------------------

describe("verify_permit (local mode)", () => {
  it("verifies a fresh local permit", async () => {
    forceLocalMode();
    const { client } = await setup();

    // Get a permit via evaluate
    const authzResult = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ok"] },
    });
    const authz = parseResult(authzResult);
    assert.equal(authz.decision, "allow");

    // Verify it
    const verifyResult = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: authz.permit_token as string },
    });
    const verified = parseResult(verifyResult);
    assert.equal(verified.outcome, "verified");
    assert.equal(verified.valid, true);
  });

  it("rejects a malformed local permit as invalid", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "garbage_token" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "invalid");
    assert.equal(data.valid, false);
    assert.equal(result.isError, true);
  });

  it("rejects a replay of an already-verified local permit", async () => {
    forceLocalMode();
    const { client } = await setup();

    const authzResult = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ok"] },
    });
    const authz = parseResult(authzResult);
    assert.equal(authz.decision, "allow");
    const token = authz.permit_token as string;

    const first = parseResult(
      await client.callTool({
        name: "verify_permit",
        arguments: { ...EVAL_ARGS, permit_token: token },
      }),
    );
    assert.equal(first.outcome, "verified");
    assert.equal(first.valid, true);

    const second = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: token },
    });
    const replay = parseResult(second);
    assert.equal(replay.outcome, "invalid");
    assert.equal(replay.valid, false);
    assert.ok(Array.isArray(replay.reasons));
    assert.match(String((replay.reasons as string[])[0] ?? ""), /already used/i);
  });
});

describe("verify_permit (remote mode)", () => {
  it("maps server allow → verified", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ valid: true, outcome: "allow", decision: "allow" });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "verified");
    assert.equal(data.valid, true);
  });

  it("maps PERMIT_EXPIRED → expired", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "PERMIT_EXPIRED",
      reasons: ["Permit expired at 2026-01-01T00:15:00Z"],
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "expired");
    assert.equal(data.valid, false);
    assert.equal(result.isError, true);
  });

  it("maps PERMIT_ALREADY_USED → invalid", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "PERMIT_ALREADY_USED",
      reasons: ["This permit token has already been consumed"],
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "invalid");
    assert.equal(data.valid, false);
  });

  it("maps RATE_LIMITED → error", async () => {
    forceRemoteMode();
    // Server returns 200 here because the verify handler emits its own
    // body for rate-limited responses (status 429 with JSON body).
    // Using mockFetch at status 200 simulates the JSON body parse path.
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "RATE_LIMITED",
      reasons: ["Too many requests"],
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "error");
    assert.equal(data.valid, false);
  });

  it("falls through to invalid on unknown verify_error_code", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "SOMETHING_NEW",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "invalid");
    assert.equal(data.valid, false);
  });

  it("returns error outcome on network failure", async () => {
    forceRemoteMode();
    const fn = async (): Promise<Response> => {
      throw new Error("ETIMEDOUT");
    };
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "error");
    assert.equal(data.valid, false);
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// deploy_service — authorization-before-execution proof
// ---------------------------------------------------------------------------

describe("deploy_service (authorization-gated)", () => {
  it("blocks the deploy when policy denies (production, no approvals)", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "production",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "deploy must NOT execute when denied");
    assert.equal(result.isError, true);
  });

  it("holds the deploy when policy holds (destructive w/o window)", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "delete-old-records",
        environment: "staging",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    // action_type is "production.deploy" in this tool, so destructive rule doesn't fire.
    // This one should allow.
    assert.equal(data.decision, "allow");
  });

  it("executes the deploy when policy allows", async () => {
    // With the two-layer gate, both agentToolGate (model.agent.execute_tool)
    // and the deploy-specific gate (production.deploy) must allow. In local
    // mode, agentToolGate uses the same local engine which denies production
    // actions without approvals — but agentToolGate only receives the
    // environment, not the per-deploy approvals. Use staging so both gates
    // pass unconditionally in local mode, verifying the full execute path.
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "staging",
        actor_id: "agent-7",
        approvals: ["ticket-42"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.ok(data.permit_token, "must return a permit_token");
    const res = data.result as Record<string, unknown>;
    assert.equal(res.status, "deployed");
    assert.equal(res.service, "billing-api");
    assert.equal(res.environment, "staging");
  });

  it("executes staging deploys without approvals", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "staging",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.ok(data.result);
  });

  it("blocks on remote fail-closed (verification failure)", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "internal" }, 500);
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "staging",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting (per-tool token bucket)", () => {
  it("denies the burst that exceeds ATLASENT_MCP_RATE_LIMIT", async () => {
    forceLocalMode();
    process.env.ATLASENT_MCP_RATE_LIMIT = "2";
    _resetRateLimitForTests();
    const { client } = await setup();

    const args = { ...EVAL_ARGS, approvals: ["x"] };
    const r1 = parseResult(await client.callTool({ name: "evaluate", arguments: args }));
    const r2 = parseResult(await client.callTool({ name: "evaluate", arguments: args }));
    const r3 = parseResult(await client.callTool({ name: "evaluate", arguments: args }));

    assert.equal(r1.decision, "allow");
    assert.equal(r2.decision, "allow");
    // Third call (within the same minute) trips the limiter.
    assert.equal(r3.decision, "deny");
    assert.ok(Array.isArray(r3.reasons));
    assert.match(String((r3.reasons as string[])[0] ?? ""), /rate limit/i);
  });
});

// ---------------------------------------------------------------------------
// Policy + permit write tools (remote-only)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function captureFetch(response: object, status = 200) {
  const captured: CapturedRequest[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    captured.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: parsedBody,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fn: mock.fn(fn), captured };
}

describe("atlasent_create_policy", () => {
  it("POSTs the policy body to /v1/policies and returns the row", async () => {
    forceRemoteMode();
    const created = { id: "pol_123", policy_id: "deploy-gate", status: "draft" };
    const { fn, captured } = captureFetch(created);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_policy",
      arguments: {
        org_id: "org_1",
        policy_id: "deploy-gate",
        title: "Deployment production gate",
        policy_type: "access_control",
        rules: [{ when: "env=production", require: "approvals>=2" }],
      },
    });
    const data = parseResult(result);
    assert.equal(data.id, "pol_123");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.match(captured[0].url, /\/v1\/policies$/);
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.org_id, "org_1");
    assert.equal(body.policy_id, "deploy-gate");
    assert.equal(body.policy_type, "access_control");
    assert.deepEqual(body.rules, [{ when: "env=production", require: "approvals>=2" }]);
  });

  it("surfaces 401 as an isError result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_policy",
      arguments: {
        org_id: "org_1",
        policy_id: "x",
        title: "x",
        policy_type: "x",
        rules: [{ a: 1 }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Authentication failed/i);
  });
});

describe("atlasent_update_policy", () => {
  it("PATCHes /v1/policies/:id with only the supplied fields", async () => {
    forceRemoteMode();
    const updated = { id: "pol_123", policy_id: "deploy-gate", status: "enforce" };
    const { fn, captured } = captureFetch(updated);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_update_policy",
      arguments: {
        policy_id: "deploy-gate",
        org_id: "org_1",
        status: "enforce",
        priority: 50,
      },
    });
    const data = parseResult(result);
    assert.equal(data.status, "enforce");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "PATCH");
    assert.match(captured[0].url, /\/v1\/policies\/deploy-gate$/);
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.org_id, "org_1");
    assert.equal(body.status, "enforce");
    assert.equal(body.priority, 50);
    // Fields the caller did not supply must not appear in the PATCH body.
    assert.equal(body.title, undefined);
    assert.equal(body.rules, undefined);
    assert.equal(body.policy_id, undefined);
  });
});

describe("atlasent_revoke_permit", () => {
  it("POSTs to /v1/permits/:permitToken/revoke with org and reasons", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({
      id: "permit_42",
      status: "revoked",
      revoked_at: "2026-05-08T00:00:00Z",
    });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_revoke_permit",
      arguments: {
        permitToken: "permit_42",
        org_id: "org_1",
        reasons: ["compromised actor"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.status, "revoked");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.match(captured[0].url, /\/v1\/permits\/permit_42\/revoke$/);
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.org_id, "org_1");
    assert.deepEqual(body.reasons, ["compromised actor"]);
  });

  it("omits reasons from the body when not supplied", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({ id: "permit_42", status: "revoked" });
    globalThis.fetch = fn;
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_revoke_permit",
      arguments: { permitToken: "permit_42", org_id: "org_1" },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal("reasons" in body, false);
  });
});

describe("atlasent_list_permits", () => {
  it("GETs /v1/permits with the supplied filters in the query string", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({
      permits: [{ id: "permit_1", status: "issued" }],
      total: 1,
      next_cursor: null,
    });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_list_permits",
      arguments: {
        org_id: "org_1",
        status: "issued",
        actor_id: "agent-7",
        limit: 25,
      },
    });
    const data = parseResult(result);
    assert.equal((data.permits as unknown[]).length, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
    const u = new URL(captured[0].url);
    assert.equal(u.pathname, "/v1/permits");
    assert.equal(u.searchParams.get("org_id"), "org_1");
    assert.equal(u.searchParams.get("status"), "issued");
    assert.equal(u.searchParams.get("actor_id"), "agent-7");
    assert.equal(u.searchParams.get("limit"), "25");
    // Unsupplied filters must not leak into the query string.
    assert.equal(u.searchParams.has("action_type"), false);
    assert.equal(u.searchParams.has("cursor"), false);
  });

  it("surfaces 429 as an isError rate-limited result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "rate limited" }, 429);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_list_permits",
      arguments: { org_id: "org_1" },
    });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Rate limited/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_permit — issue a permit token
// ---------------------------------------------------------------------------

describe("atlasent_permit", () => {
  it("happy path: returns permit object from API", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      permit_token: "pt_issued_abc",
      expires_at: "2026-01-01T01:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_permit",
      arguments: {
        subject: "user:alice",
        action: "production.deploy",
        resource: "env:prod",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.equal(data.permit_token, "pt_issued_abc");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_permit",
      arguments: {
        subject: "user:alice",
        action: "production.deploy",
        resource: "env:prod",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing required subject field", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_permit",
      arguments: {
        action: "production.deploy",
        resource: "env:prod",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /subject/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_verify_permit (v1)
// ---------------------------------------------------------------------------

describe("atlasent_verify_permit (v1)", () => {
  it("happy path: returns valid verification from API", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ valid: true, outcome: "allow" });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_verify_permit",
      arguments: {
        permit_token: "pt_abc123",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.equal(data.valid, true);
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_verify_permit",
      arguments: {
        permit_token: "pt_abc123",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing permit_token", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_verify_permit",
      arguments: { org_id: "org_abc" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /permit_token/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_create_approval_request
// ---------------------------------------------------------------------------

describe("atlasent_create_approval_request", () => {
  it("happy path: returns approval_request_id", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      approval_request_id: "apr_xyz",
      status: "pending",
      created_at: "2026-01-01T00:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_approval_request",
      arguments: {
        subject: "user:alice",
        action: "delete:production-db",
        resource: "db:prod-postgres",
        org_id: "org_abc",
        justification: "Need to clean up old records",
      },
    });
    const data = parseResult(result);
    assert.equal(data.approval_request_id, "apr_xyz");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_approval_request",
      arguments: {
        subject: "user:alice",
        action: "delete:production-db",
        resource: "db:prod-postgres",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing resource", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_approval_request",
      arguments: {
        subject: "user:alice",
        action: "delete:production-db",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /resource/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_resolve_approval_request
// ---------------------------------------------------------------------------

describe("atlasent_resolve_approval_request", () => {
  it("happy path: approve returns resolved status", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      approval_request_id: "apr_xyz",
      status: "approved",
      resolver_id: "user:bob",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_resolve_approval_request",
      arguments: {
        approval_request_id: "apr_xyz",
        org_id: "org_abc",
        resolution: "approve",
        resolver_id: "user:bob",
        comment: "LGTM",
      },
    });
    const data = parseResult(result);
    assert.equal(data.status, "approved");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_resolve_approval_request",
      arguments: {
        approval_request_id: "apr_xyz",
        org_id: "org_abc",
        resolution: "deny",
        resolver_id: "user:bob",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: invalid resolution value", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_resolve_approval_request",
      arguments: {
        approval_request_id: "apr_xyz",
        org_id: "org_abc",
        resolution: "maybe",
        resolver_id: "user:bob",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /resolution/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_delete_policy
// ---------------------------------------------------------------------------

describe("atlasent_delete_policy", () => {
  it("happy path: returns empty body on successful delete", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({});
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_policy",
      arguments: {
        policy_id: "pol_abc",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_policy",
      arguments: {
        policy_id: "pol_abc",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing org_id", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_policy",
      arguments: { policy_id: "pol_abc" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /org_id/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_record_execution_evaluation
// ---------------------------------------------------------------------------

describe("atlasent_record_execution_evaluation", () => {
  it("happy path: returns recorded evaluation", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      execution_id: "exec_abc",
      outcome: "success",
      recorded_at: "2026-01-01T00:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_record_execution_evaluation",
      arguments: {
        evaluation_id: "eval_abc",
        org_id: "org_abc",
        outcome: "success",
        executed_at: "2026-01-01T00:00:00Z",
      },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "success");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_record_execution_evaluation",
      arguments: {
        evaluation_id: "eval_abc",
        org_id: "org_abc",
        outcome: "failure",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: invalid outcome value", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_record_execution_evaluation",
      arguments: {
        evaluation_id: "eval_abc",
        org_id: "org_abc",
        outcome: "partial",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /outcome/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_create_webhook
// ---------------------------------------------------------------------------

describe("atlasent_create_webhook", () => {
  it("happy path: returns webhook_id", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      webhook_id: "wh_abc123",
      url: "https://example.com/hooks/atlasent",
      events: ["evaluation.deny"],
      secret: "whsec_xxxxx",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_webhook",
      arguments: {
        org_id: "org_abc",
        url: "https://example.com/hooks/atlasent",
        events: ["evaluation.deny", "approval.requested"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.webhook_id, "wh_abc123");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_webhook",
      arguments: {
        org_id: "org_abc",
        url: "https://example.com/hooks/atlasent",
        events: ["evaluation.deny"],
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing events array", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_webhook",
      arguments: {
        org_id: "org_abc",
        url: "https://example.com/hooks/atlasent",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /events/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_delete_webhook
// ---------------------------------------------------------------------------

describe("atlasent_delete_webhook", () => {
  it("happy path: returns empty body on successful delete", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({});
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_webhook",
      arguments: {
        webhook_id: "wh_abc123",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_webhook",
      arguments: {
        webhook_id: "wh_abc123",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing webhook_id", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_webhook",
      arguments: { org_id: "org_abc" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /webhook_id/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_evaluate — explain flag and risk_envelope
// ---------------------------------------------------------------------------

describe("atlasent_evaluate explain + risk_envelope", () => {
  it("forwards explain=true to the API request body", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(
        JSON.stringify({ decision: "allow", permitToken: "pt_explain_1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
        explain: true,
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.explain, true);
  });

  it("does not include explain in the API body when omitted", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(
        JSON.stringify({ decision: "allow", permitToken: "pt_no_explain" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal("explain" in body, false);
  });

  it("includes risk_envelope in the response when the API returns one", async () => {
    forceRemoteMode();
    const riskEnvelope = {
      weighted_score: 0.72,
      engine_decision: "allow",
      envelope_decision: "allow",
      promoted: false,
      hard_blocks: [],
      factors: {
        time_of_day: { score: 0.3, weight: 0.5, contribution: 0.15 },
        approval_count: { score: 1.0, weight: 0.5, contribution: 0.5 },
      },
    };
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "allow",
          permitToken: "pt_risk_1",
          risk_envelope: riskEnvelope,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
        explain: true,
      },
    });
    const data = parseResult(result);
    const envelope = data.risk_envelope as Record<string, unknown>;
    assert.ok(envelope, "risk_envelope must be present");
    assert.equal(envelope.weighted_score, 0.72);
    assert.equal(envelope.engine_decision, "allow");
    assert.equal(envelope.envelope_decision, "allow");
    assert.equal(envelope.promoted, false);
    assert.deepEqual(envelope.hard_blocks, []);
    const factors = envelope.factors as Record<string, unknown>;
    assert.ok(factors, "factors must be present");
    assert.deepEqual(factors.time_of_day, { score: 0.3, weight: 0.5, contribution: 0.15 });
    assert.deepEqual(factors.approval_count, { score: 1.0, weight: 0.5, contribution: 0.5 });
  });

  it("omits risk_envelope from the response when the API does not return one", async () => {
    forceRemoteMode();
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({ decision: "allow", permitToken: "pt_no_risk" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
      },
    });
    const data = parseResult(result);
    assert.equal(data.risk_envelope, undefined);
  });

  it("includes risk_envelope without factors when explain is not set", async () => {
    forceRemoteMode();
    const riskEnvelope = {
      weighted_score: 0.45,
      engine_decision: "allow",
      envelope_decision: "allow",
      promoted: false,
      hard_blocks: [],
    };
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "allow",
          permitToken: "pt_risk_no_factors",
          risk_envelope: riskEnvelope,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
      },
    });
    const data = parseResult(result);
    const envelope = data.risk_envelope as Record<string, unknown>;
    assert.ok(envelope, "risk_envelope must be present");
    assert.equal(envelope.weighted_score, 0.45);
    assert.equal(envelope.factors, undefined);
  });
});

// ---------------------------------------------------------------------------
// atlasent_trajectory_verify
// ---------------------------------------------------------------------------

describe("atlasent_trajectory_verify", () => {
  it("returns on_trajectory=true and no isError on a 200 success response", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      on_trajectory: true,
      trajectory_position: 2,
      trajectory_complete: false,
      verified_at: "2026-05-30T10:00:00.000Z",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_trajectory_verify",
      arguments: {
        permit_token: "pt_traj_abc",
        current_step: "fetch_customer_records",
        completed_steps: ["validate_inputs"],
        execution_context: { session_id: "sess_1" },
      },
    });
    const data = parseResult(result);
    assert.equal(data.on_trajectory, true);
    assert.equal(data.trajectory_position, 2);
    assert.equal(data.trajectory_complete, false);
    assert.equal(result.isError, undefined);
  });

  it("returns on_trajectory=false and isError=true when the API signals a deviation", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      on_trajectory: false,
      trajectory_complete: false,
      verified_at: "2026-05-30T10:00:01.000Z",
      deviation: { reason: "step not in approved plan", trajectory_id: "traj_999" },
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_trajectory_verify",
      arguments: {
        permit_token: "pt_traj_abc",
        current_step: "drop_database",
      },
    });
    const data = parseResult(result);
    assert.equal(data.on_trajectory, false);
    assert.ok(data.deviation, "deviation must be present");
    assert.equal(data.halt, true);
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// atlasent_lookup_action — Canon-native lookup (canon_id + graph relationships)
// ---------------------------------------------------------------------------

describe("atlasent_lookup_action (Canon-native)", () => {
  it("lists the full Canon when called with no arguments", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_lookup_action", arguments: {} });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.ok((body.result_count as number) >= 29, "expected the full 29+ action Canon");
  });

  it("returns canon_id and graph relationships for an exact slug", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_lookup_action",
      arguments: { slug: "production.deploy" },
    });
    const body = parseResult(result);
    assert.equal(body.found, true);
    const action = (body.actions as Array<Record<string, unknown>>)[0];
    assert.match(String(action.canon_id), /^CANON-\d{6}$/);
    const rel = action.relationships as {
      requires: string[];
      produces: string[];
      pattern: string;
    };
    assert.ok(rel, "expected knowledge-graph relationships");
    assert.equal(rel.pattern, "four-eyes");
    assert.ok(rel.requires.includes("approval"), "deploy requires approval");
    assert.ok(rel.produces.includes("permit"), "deploy produces a permit");
  });

  it("surfaces the flagship agent action added in the catalog expansion", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_lookup_action",
      arguments: { slug: "agent.tool.invoke" },
    });
    const body = parseResult(result);
    assert.equal(body.found, true);
    const action = (body.actions as Array<Record<string, unknown>>)[0];
    const rel = action.relationships as { assertions: string[] };
    assert.ok(rel.assertions.includes("identity"), "agent.tool.invoke requires identity assertion");
  });
});
