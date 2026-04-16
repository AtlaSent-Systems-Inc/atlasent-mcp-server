import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const EVAL_ARGS = {
  action_type: "deploy",
  actor_id: "user-1",
  environment: "production",
};

const VERIFY_ARGS = {
  permit_token: "pt_abc123",
  ...EVAL_ARGS,
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

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("tools/list", () => {
  it("exposes evaluate and verify_permit", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["evaluate", "verify_permit"]);
  });

  it("evaluate has correct required fields", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const evaluate = tools.find((t) => t.name === "evaluate")!;
    assert.deepEqual(
      (evaluate.inputSchema as { required?: string[] }).required?.sort(),
      ["action_type", "actor_id", "environment"],
    );
  });

  it("verify_permit requires permit_token", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const verify = tools.find((t) => t.name === "verify_permit")!;
    const required = (verify.inputSchema as { required?: string[] }).required ?? [];
    assert.ok(required.includes("permit_token"));
  });
});

describe("evaluate", () => {
  it("returns decision and permit_token on success", async () => {
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_xyz" });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "allow");
    assert.equal(data.permit_token, "pt_xyz");
    assert.equal(result.isError, undefined);
  });

  it("surfaces optional fields when present", async () => {
    const fetcher = mockFetch({
      decision: "deny",
      permit_token: "",
      reason: "policy violation",
      audit_id: "aud_123",
      conditions: ["require_approval"],
    });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);

    assert.equal(data.reason, "policy violation");
    assert.equal(data.audit_id, "aud_123");
    assert.deepEqual(data.conditions, ["require_approval"]);
  });

  it("passes approvals and change_window when provided", async () => {
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_1" });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    await client.callTool({
      name: "evaluate",
      arguments: {
        ...EVAL_ARGS,
        approvals: ["ticket-42"],
        change_window: "2025-01-15T02:00:00Z/PT4H",
      },
    });

    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.approvals, ["ticket-42"]);
    assert.equal(body.change_window, "2025-01-15T02:00:00Z/PT4H");
  });

  it("sends correct headers", async () => {
    process.env.ATLASENT_API_KEY = "test-key";
    process.env.ATLASENT_ANON_KEY = "test-anon";
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_1" });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });

    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    assert.equal(headers["x-anon-key"], "test-anon");
    assert.ok(headers["User-Agent"].startsWith("@atlasent/mcp-server/"));

    delete process.env.ATLASENT_API_KEY;
    delete process.env.ATLASENT_ANON_KEY;
  });

  it("denies on HTTP 500", async () => {
    globalThis.fetch = mockFetch({ error: "internal" }, 500);
    const { client } = await setup();

    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);
  });

  it("denies on HTTP 403", async () => {
    globalThis.fetch = mockFetch({ error: "forbidden" }, 403);
    const { client } = await setup();

    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);
  });

  it("denies on network error", async () => {
    const fn = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();

    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.ok((data.reason as string).includes("ECONNREFUSED"));
    assert.equal(result.isError, true);
  });

  it("denies on malformed JSON response", async () => {
    const fn = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } });
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();

    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);
  });
});

describe("verify_permit", () => {
  it("returns outcome and valid on success", async () => {
    const fetcher = mockFetch({ outcome: "verified", valid: true });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    const result = await client.callTool({ name: "verify_permit", arguments: VERIFY_ARGS });
    const data = parseResult(result);

    assert.equal(data.outcome, "verified");
    assert.equal(data.valid, true);
    assert.equal(result.isError, undefined);
  });

  it("surfaces optional fields when present", async () => {
    const fetcher = mockFetch({
      outcome: "expired",
      valid: false,
      reason: "permit expired",
      audit_id: "aud_456",
    });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    const result = await client.callTool({ name: "verify_permit", arguments: VERIFY_ARGS });
    const data = parseResult(result);

    assert.equal(data.outcome, "expired");
    assert.equal(data.valid, false);
    assert.equal(data.reason, "permit expired");
    assert.equal(data.audit_id, "aud_456");
  });

  it("posts to /v1-verify-permit with permit_token", async () => {
    const fetcher = mockFetch({ outcome: "verified", valid: true });
    globalThis.fetch = fetcher;
    const { client } = await setup();

    await client.callTool({ name: "verify_permit", arguments: VERIFY_ARGS });

    const url = fetcher.mock.calls[0].arguments[0] as string;
    assert.ok(url.endsWith("/v1-verify-permit"));
    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    assert.equal(body.permit_token, "pt_abc123");
  });

  it("denies on HTTP 500", async () => {
    globalThis.fetch = mockFetch({ error: "internal" }, 500);
    const { client } = await setup();

    const result = await client.callTool({ name: "verify_permit", arguments: VERIFY_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);
  });

  it("denies on network error", async () => {
    const fn = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      throw new Error("ETIMEDOUT");
    };
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();

    const result = await client.callTool({ name: "verify_permit", arguments: VERIFY_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.ok((data.reason as string).includes("ETIMEDOUT"));
    assert.equal(result.isError, true);
  });
});
