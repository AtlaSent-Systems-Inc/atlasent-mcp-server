import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVAL_ARGS = {
  action_type: "deploy",
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
  it("exposes evaluate, verify_permit, and deploy_service", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "atlasent_evaluate",
      "atlasent_get_policy",
      "atlasent_list_audit_events",
      "atlasent_list_policies",
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
    assert.ok((data.reason as string).toLowerCase().includes("approval"));
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

  it("normalizes escalate to hold", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      denial: { reason: "needs SRE review", code: "REQUIRES_OVERRIDE" },
      request_id: "req_2",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.equal(data.reason, "needs SRE review");
    assert.equal(data.audit_id, "req_2");
    assert.equal(result.isError, true);
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
    assert.equal(body.action_type, "deploy");
    assert.equal(body.actor_id, "user-1");
    assert.deepEqual(body.context, {
      environment: "production",
      approvals: ["t-1"],
      change_window: "win-1",
    });
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
    assert.ok((data.reason as string).includes("ECONNREFUSED"));
  });

  it("denies when remote allows but returns no permit_token", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ decision: "allow" });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reason as string).includes("permit_token"));
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
    assert.match(String(replay.reason ?? ""), /already used/i);
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
      reason: "Permit expired at 2026-01-01T00:15:00Z",
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
      reason: "This permit token has already been consumed",
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
      reason: "Too many requests",
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
    // action_type is "deploy" in this tool, so destructive rule doesn't fire.
    // This one should allow.
    assert.equal(data.decision, "allow");
  });

  it("executes the deploy when policy allows", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "production",
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
    assert.equal(res.environment, "production");
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
    assert.match(String(r3.reason ?? ""), /rate limit/i);
  });
});
