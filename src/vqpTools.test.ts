import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function setup() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vqp-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.ATLASENT_SUPABASE_URL = "https://project.supabase.co";
  process.env.ATLASENT_SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
  process.env.ATLASENT_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_SUPABASE_URL;
  delete process.env.ATLASENT_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ATLASENT_BASE_URL;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_MCP_READONLY;
});

describe("tools/list includes VQP tools", () => {
  it("registers all 4 VQP tools by default", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("atlasent_vqp_generate"));
    assert.ok(names.has("atlasent_vqp_verify"));
    assert.ok(names.has("atlasent_vqp_audit_summary"));
    assert.ok(names.has("atlasent_vqp_drift_events"));
  });

  it("hides the mutating VQP tools (generate, verify) in READONLY mode", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.equal(names.has("atlasent_vqp_generate"), false);
    assert.equal(names.has("atlasent_vqp_verify"), false);
    // Read-only report tools must stay available.
    assert.ok(names.has("atlasent_vqp_audit_summary"));
    assert.ok(names.has("atlasent_vqp_drift_events"));
  });
});

// ---------------------------------------------------------------------------
// atlasent_vqp_verify — the response-shape / integrity-signal bug fix.
//
// The real v1-verify-vqp success response never carries `decision`, `valid`,
// or `error` — its integrity signal is `hash_match`. Before this fix,
// toolResult() had no way to tell a tampered snapshot from a clean one.
// ---------------------------------------------------------------------------

describe("atlasent_vqp_verify", () => {
  it("returns success (isError unset) when hash_match is true", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse(
        {
          snapshot_id: "snap-1",
          hash_match: true,
          original_prompt_hash: "abc123",
          rerun_prompt_hash: "abc123",
          rerun_score: null,
          rerun_verdict: null,
          score_delta: null,
          verdict_changed: null,
          audit_log_id: "log-1",
        },
        201,
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "snap-1" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, undefined);
    assert.equal(data.hash_match, true);
    assert.equal(data.error, undefined);
  });

  it("BUG FIX: surfaces hash_match: false as an explicit isError result", async () => {
    // Regression test: this is the exact shape v1-verify-vqp returns on a
    // tampered/drifted snapshot. Before the fix, toolResult() found no
    // `decision`/`valid`/`error` field on this payload and silently
    // reported it as a successful (isError unset) result — indistinguishable
    // from a clean hash match.
    globalThis.fetch = mock.fn(async () =>
      jsonResponse(
        {
          snapshot_id: "snap-2",
          hash_match: false,
          original_prompt_hash: "abc123",
          rerun_prompt_hash: "def456",
          rerun_score: null,
          rerun_verdict: null,
          score_delta: null,
          verdict_changed: null,
          audit_log_id: "log-2",
        },
        201,
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "snap-2" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, true, "hash_match: false MUST surface as isError");
    assert.equal(data.error, "hash_mismatch");
    assert.equal(data.hash_match, false);
    // Original fields must not be dropped — an investigator needs both hashes.
    assert.equal(data.original_prompt_hash, "abc123");
    assert.equal(data.rerun_prompt_hash, "def456");
    assert.equal(data.snapshot_id, "snap-2");
  });

  it("does not flag isError merely because verdict_changed is true (hash intact)", async () => {
    // verdict_changed alone (AI re-run scored differently) is expected model
    // variance, not tampering — must not be conflated with hash_mismatch.
    globalThis.fetch = mock.fn(async () =>
      jsonResponse(
        {
          snapshot_id: "snap-3",
          hash_match: true,
          original_prompt_hash: "abc123",
          rerun_prompt_hash: "abc123",
          rerun_score: 62,
          rerun_verdict: "conditionally_qualified",
          score_delta: -23,
          verdict_changed: true,
          audit_log_id: "log-3",
        },
        201,
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "snap-3", rerun: true },
    });
    const data = parseResult(result);
    assert.equal(result.isError, undefined);
    assert.equal(data.error, undefined);
    // The drift signal itself must still be visible to the caller.
    assert.equal(data.verdict_changed, true);
    assert.equal(data.score_delta, -23);
  });

  it("forwards rerun flag to the edge function", async () => {
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return jsonResponse({ snapshot_id: "snap-4", hash_match: true }, 201);
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "snap-4", rerun: true },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.snapshot_id, "snap-4");
    assert.equal(body.rerun, true);
  });

  it("fails closed with a clear error when ATLASENT_SUPABASE_URL is unset", async () => {
    delete process.env.ATLASENT_SUPABASE_URL;
    globalThis.fetch = mock.fn(async () => jsonResponse({ hash_match: true }, 201));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "snap-5" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, true);
    assert.match(String(data.error), /ATLASENT_SUPABASE_URL/);
  });

  it("surfaces an edge-function HTTP error", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({ message: "Snapshot not found" }, 404),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "does-not-exist" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, true);
    assert.equal(data.error, "Snapshot not found");
  });

  it("is not registered when ATLASENT_MCP_READONLY=1", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_verify",
      arguments: { snapshot_id: "snap-1" },
    });
    // The MCP SDK resolves with an isError result for an unregistered tool
    // rather than throwing.
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// atlasent_vqp_generate
// ---------------------------------------------------------------------------

describe("atlasent_vqp_generate", () => {
  it("returns the stored snapshot on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse(
        {
          snapshot: {
            id: "snap-6",
            quality_score: 91,
            overall_verdict: "qualified",
          },
          cached: false,
        },
        201,
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_generate",
      arguments: { bundle_id: "bundle-1", org_id: "org-1" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, undefined);
    const snapshot = data.snapshot as Record<string, unknown>;
    assert.equal(snapshot.overall_verdict, "qualified");
  });

  it("forwards optional vqp_context", async () => {
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return jsonResponse({ snapshot: { id: "snap-7" }, cached: false }, 201);
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_vqp_generate",
      arguments: {
        bundle_id: "bundle-1",
        org_id: "org-1",
        vqp_context: { deploy_target: "prod" },
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.deepEqual(body.vqp_context, { deploy_target: "prod" });
  });

  it("is not registered when ATLASENT_MCP_READONLY=1", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    assert.equal(tools.some((t) => t.name === "atlasent_vqp_generate"), false);
  });
});

// ---------------------------------------------------------------------------
// atlasent_vqp_audit_summary (read-only, standard REST API)
// ---------------------------------------------------------------------------

describe("atlasent_vqp_audit_summary", () => {
  it("returns the report on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({ hash_match_rate: 0.98, drift_events: 3, verdict_changes: 1 }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_audit_summary",
      arguments: { org_id: "org-1" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, undefined);
    assert.equal(data.hash_match_rate, 0.98);
  });

  it("forwards org_id/from/to as query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock.fn(async (url) => {
      capturedUrl = String(url);
      return jsonResponse({ hash_match_rate: 1 });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_vqp_audit_summary",
      arguments: { org_id: "org-1", from: "2026-01-01", to: "2026-02-01" },
    });
    assert.ok(capturedUrl.includes("/v1/bccae-reports/vqp-audit-summary"));
    assert.ok(capturedUrl.includes("org_id=org-1"));
    assert.ok(capturedUrl.includes("from=2026-01-01"));
    assert.ok(capturedUrl.includes("to=2026-02-01"));
  });

  it("remains registered in READONLY mode", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "atlasent_vqp_audit_summary"));
  });

  it("surfaces a non-2xx API response as an error", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}, 500));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_audit_summary",
      arguments: { org_id: "org-1" },
    });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// atlasent_vqp_drift_events (read-only, standard REST API)
// ---------------------------------------------------------------------------

describe("atlasent_vqp_drift_events", () => {
  it("returns the drift list on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({ events: [{ snapshot_id: "s1", score_delta: -15 }] }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_drift_events",
      arguments: { org_id: "org-1" },
    });
    const data = parseResult(result);
    assert.equal(result.isError, undefined);
    assert.equal((data.events as unknown[]).length, 1);
  });

  it("forwards limit as a string query param", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock.fn(async (url) => {
      capturedUrl = String(url);
      return jsonResponse({ events: [] });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_vqp_drift_events",
      arguments: { org_id: "org-1", limit: 50 },
    });
    assert.ok(capturedUrl.includes("limit=50"));
  });

  it("rejects limit > 100 at the tool layer", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_vqp_drift_events",
      arguments: { org_id: "org-1", limit: 101 },
    });
    assert.equal(result.isError, true);
  });

  it("remains registered in READONLY mode", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "atlasent_vqp_drift_events"));
  });
});
