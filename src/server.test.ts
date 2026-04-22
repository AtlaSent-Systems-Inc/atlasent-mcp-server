import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

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

/**
 * Tool results carry two content blocks: a human-readable banner and a
 * structured JSON payload. Parse the payload from the last block.
 */
function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const blocks = result.content as Array<{ type: string; text: string }>;
  const text = blocks[blocks.length - 1]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function banner(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = result.content as Array<{ type: string; text: string }>;
  return blocks[0]?.text ?? "";
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMode();
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("exposes all AtlaSent primitives + protected demo tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "access_sensitive_dataset",
      "deploy_service",
      "evaluate",
      "send_email",
      "verify_permit",
      "write_to_production",
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

  it("send_email requires to, subject, body, actor_id", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const t = tools.find((t) => t.name === "send_email")!;
    const required = (t.inputSchema as { required?: string[] }).required ?? [];
    for (const f of ["to", "subject", "body", "actor_id"]) {
      assert.ok(required.includes(f), `missing required field: ${f}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Envelope — banner + JSON
// ---------------------------------------------------------------------------

describe("tool result envelope", () => {
  it("emits a [BLOCKED BY ATLASENT] banner on deny", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    assert.ok(banner(result).startsWith("[BLOCKED BY ATLASENT]"));
    assert.equal(result.isError, true);
  });

  it("emits a [ALLOWED BY ATLASENT] banner on allow", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ok"] },
    });
    assert.ok(banner(result).startsWith("[ALLOWED BY ATLASENT]"));
    assert.equal(result.isError, undefined);
  });

  it("emits a [HELD BY ATLASENT] banner on hold", async () => {
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
    assert.ok(banner(result).startsWith("[HELD BY ATLASENT]"));
    assert.equal(result.isError, true);
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

  it("denies sensitive-context actions without approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "access_dataset",
        actor_id: "analyst",
        environment: "staging",
        context: { sensitivity: "pii", dataset_id: "customers" },
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reason as string).toLowerCase().includes("pii"));
  });

  it("denies external-context actions without approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "send_email",
        actor_id: "agent",
        environment: "staging",
        context: { external: true, recipient: "x@y.com" },
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reason as string).toLowerCase().includes("external"));
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
      audit_id: "aud_1",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.permit_token, "pt_xyz");
    assert.equal(data.audit_id, "aud_1");
  });

  it("normalizes escalate to hold", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      reason: "needs SRE review",
      hold_id: "hold_1",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.equal(data.hold_id, "hold_1");
    assert.equal(result.isError, true);
  });

  it("sends correct auth headers and forwards context", async () => {
    forceRemoteMode();
    process.env.ATLASENT_ANON_KEY = "test-anon";
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_1" });
    globalThis.fetch = fetcher;
    const { client } = await setup();
    await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, context: { recipient: "a@b.com", external: true } },
    });

    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    assert.equal(headers["x-anon-key"], "test-anon");
    assert.ok(headers["User-Agent"].startsWith("@atlasent/mcp-server/"));

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    assert.deepEqual(body.context, { recipient: "a@b.com", external: true });
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

    const authzResult = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ok"] },
    });
    const authz = parseResult(authzResult);
    assert.equal(authz.decision, "allow");

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
});

describe("verify_permit (remote mode)", () => {
  it("returns outcome and valid on success", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ outcome: "verified", valid: true, audit_id: "aud_1" });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "verified");
    assert.equal(data.valid, true);
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
// send_email — authorization-before-execution
// ---------------------------------------------------------------------------

describe("send_email (authorization-gated)", () => {
  it("blocks external recipients without approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "send_email",
      arguments: {
        to: "outsider@competitor.com",
        subject: "Hi",
        body: "Hello",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "email must NOT send when denied");
    assert.equal(result.isError, true);
    assert.ok(banner(result).startsWith("[BLOCKED BY ATLASENT]"));
  });

  it("sends internal emails without an approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "send_email",
      arguments: {
        to: "alice@acme.corp",
        subject: "Hi",
        body: "Hello",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    const res = data.result as Record<string, unknown>;
    assert.equal(res.status, "sent");
    assert.equal(res.to, "alice@acme.corp");
  });

  it("sends external emails when an approval is attached", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "send_email",
      arguments: {
        to: "partner@external.com",
        subject: "Hi",
        body: "Hello",
        actor_id: "agent-7",
        approvals: ["ticket-external-99"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// access_sensitive_dataset — authorization-before-execution
// ---------------------------------------------------------------------------

describe("access_sensitive_dataset (authorization-gated)", () => {
  it("blocks PII dataset reads without approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "access_sensitive_dataset",
      arguments: {
        dataset_id: "customers_pii",
        purpose: "cohort analysis",
        actor_id: "agent-analyst",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "read must NOT return rows when denied");
    assert.equal(result.isError, true);
  });

  it("allows public dataset reads", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "access_sensitive_dataset",
      arguments: {
        dataset_id: "public_benchmarks",
        purpose: "report",
        actor_id: "agent-analyst",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    const res = data.result as Record<string, unknown>;
    assert.equal(res.classification, "public");
  });

  it("allows PII reads when an approval is attached", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "access_sensitive_dataset",
      arguments: {
        dataset_id: "customers_pii",
        purpose: "cohort analysis",
        actor_id: "agent-analyst",
        approvals: ["dpo-approval-3"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// write_to_production — authorization-before-execution
// ---------------------------------------------------------------------------

describe("write_to_production (authorization-gated)", () => {
  it("blocks production writes with no approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "write_to_production",
      arguments: {
        system: "billing-db",
        operation: "apply_refund",
        payload: { customer_id: "cust_42", amount_cents: 12500 },
        environment: "production",
        actor_id: "agent-ops",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "write must NOT apply when denied");
  });

  it("executes production writes with approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "write_to_production",
      arguments: {
        system: "billing-db",
        operation: "apply_refund",
        payload: { customer_id: "cust_42", amount_cents: 12500 },
        environment: "production",
        actor_id: "agent-ops",
        approvals: ["ticket-42"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    const res = data.result as Record<string, unknown>;
    assert.equal(res.status, "written");
    assert.equal(res.system, "billing-db");
  });

  it("executes non-production writes without approval", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "write_to_production",
      arguments: {
        system: "billing-db",
        operation: "apply_refund",
        payload: {},
        environment: "staging",
        actor_id: "agent-ops",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// deploy_service — original demo tool, kept for back-compat
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
