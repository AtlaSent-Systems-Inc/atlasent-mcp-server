/**
 * atlasent_await_approval (CROSS-056): waits for a PERSON's decision on a
 * held action and claims the permit on approval. It can never approve, and
 * every outcome other than a genuinely claimed permit is "no permit".
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { awaitApproval, authorize } from "./engine.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

type Route = (method: string, path: string) => { status: number; body: unknown } | "throw";

let originalFetch: typeof globalThis.fetch;
const calls: string[] = [];

function route(fn: Route): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    calls.push(`${method} ${path}`);
    const r = fn(method, path);
    if (r === "throw") throw new Error("network down");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const FAST = { approval_request_id: "apr_1", max_wait_ms: 2_000, poll_interval_ms: 5 };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls.length = 0;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test/functions/v1";
  _resetRateLimitForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
});

describe("awaitApproval", () => {
  it("returns the claimed permit once a person approves (after pending polls)", async () => {
    let polls = 0;
    route((m, p) => {
      if (m === "GET" && p === "/v1/approvals/apr_1") {
        polls += 1;
        return { status: 200, body: { status: polls < 3 ? "pending" : "approved" } };
      }
      if (m === "POST" && p === "/v1/approvals/apr_1/claim-permit") {
        return { status: 200, body: { claimed: true, permit_token: "pt.v4.abc" } };
      }
      return { status: 500, body: {} };
    });
    const r = await awaitApproval(FAST);
    assert.deepEqual(r, { outcome: "approved", permit_token: "pt.v4.abc", approval_request_id: "apr_1" });
    // REST family is served at the gateway root, not under /functions/v1.
    assert.ok(calls.includes("GET /v1/approvals/apr_1"));
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1, "claims exactly once");
  });

  const noPermitCases: Array<[string, Route]> = [
    ["the person rejected it", (m) => (m === "GET" ? { status: 200, body: { status: "denied" } } : { status: 500, body: {} })],
    ["the request expired", (m) => (m === "GET" ? { status: 200, body: { status: "expired" } } : { status: 500, body: {} })],
    ["approved but the claim was already taken", (m) =>
      m === "GET" ? { status: 200, body: { status: "approved" } } : { status: 200, body: { claimed: false } }],
    ["approved but the claim says claimed:false (even if a token is present)", (m) =>
      m === "GET"
        ? { status: 200, body: { status: "approved" } }
        : { status: 200, body: { claimed: false, permit_token: "pt.v4.stale" } }],
    ["approved but the claim returned no token", (m) =>
      m === "GET" ? { status: 200, body: { status: "approved" } } : { status: 200, body: { claimed: true } }],
    ["approved but the claim errored", (m) =>
      m === "GET" ? { status: 200, body: { status: "approved" } } : { status: 500, body: {} }],
    ["the key lacks approvals:read", () => ({ status: 403, body: {} })],
    ["the request does not exist", () => ({ status: 404, body: {} })],
  ];
  for (const [label, fn] of noPermitCases) {
    it(`gives no permit when ${label}`, async () => {
      route(fn);
      const r = await awaitApproval(FAST);
      assert.equal(r.outcome, "not_approved");
      assert.equal("permit_token" in r, false);
    });
  }

  it("times out with no permit when nobody decides, surviving network blips", async () => {
    let n = 0;
    route(() => (++n % 2 === 0 ? "throw" : { status: 200, body: { status: "pending" } }));
    const r = await awaitApproval({ ...FAST, max_wait_ms: 60 });
    assert.equal(r.outcome, "timeout");
    assert.equal("permit_token" in r, false);
  });
});

describe("hold results carry approval_request_id", () => {
  it("authorize() keeps it so a host can wait on it", async () => {
    route((_m, p) =>
      p === "/functions/v1/v1-evaluate"
        ? { status: 200, body: { decision: "hold", deny_reason: "needs a person", approval_request_id: "apr_9" } }
        : { status: 500, body: {} },
    );
    const d = await authorize({ action_type: "data.delete", actor_id: "agent:claude", environment: "production" });
    assert.equal(d.decision, "hold");
    assert.equal(d.decision === "hold" && d.approval_request_id, "apr_9");
  });
});

describe("atlasent_await_approval tool", () => {
  async function client() {
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const cl = new Client({ name: "t", version: "1" });
    await Promise.all([cl.connect(c), server.connect(s)]);
    return cl;
  }

  it("has no input that could approve or decide", async () => {
    const { tools } = await (await client()).listTools();
    const t = tools.find((x) => x.name === "atlasent_await_approval");
    assert.ok(t, "tool registered");
    const props = Object.keys((t!.inputSchema as { properties?: object }).properties ?? {}).sort();
    assert.deepEqual(props, ["approval_request_id", "max_wait_seconds"]);
  });

  it("never approves in local mode", async () => {
    process.env.ATLASENT_MODE = "local";
    const res = await (await client()).callTool({
      name: "atlasent_await_approval",
      arguments: { approval_request_id: "apr_1", max_wait_seconds: 5 },
    });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    assert.equal(body.outcome, "not_approved");
    assert.equal("permit_token" in body, false);
  });
});
