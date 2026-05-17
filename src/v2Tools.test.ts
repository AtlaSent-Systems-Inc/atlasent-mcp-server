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

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
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
  const client = new Client({ name: "v2-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
});

// ---------------------------------------------------------------------------
// tools/list — confirms v2 tools are registered
// ---------------------------------------------------------------------------

describe("tools/list includes v2 tools", () => {
  it("registers atlasent_evaluate_many, atlasent_evaluate_stream, atlasent_query", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("atlasent_evaluate_many"));
    assert.ok(names.has("atlasent_evaluate_stream"));
    assert.ok(names.has("atlasent_query"));
  });
});

// ---------------------------------------------------------------------------
// atlasent_evaluate_many
// ---------------------------------------------------------------------------

describe("atlasent_evaluate_many", () => {
  it("returns canonical batch shape on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [{ decision: "allow", permit_token: "pt_a" }],
        partial: false,
      }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [{ action: "deploy", agent: "agent-1" }],
      },
    });
    const data = parseResult(result);
    assert.equal(data.batch_id, "11111111-1111-4111-8111-111111111111");
    assert.equal((data.items as unknown[]).length, 1);
    assert.equal(data.partial, false);
    assert.equal(result.isError, undefined);
  });

  it("surfaces 404 as feature_not_enabled with v2_batch flag", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_enabled" }, 404));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: { items: [{ action: "deploy", agent: "agent-1" }] },
    });
    const data = parseResult(result);
    assert.equal(data.error, "feature_not_enabled");
    assert.equal(data.flag, "v2_batch");
    assert.equal(result.isError, true);
  });

  it("rejects > 100 items at the tool layer", async () => {
    const { client } = await setup();
    const items = Array.from({ length: 101 }, () => ({
      action: "deploy",
      agent: "a",
    }));
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: { items },
    });
    assert.equal(result.isError, true);
  });

  it("rejects malformed batch_id (not a UUID)", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [{ action: "deploy", agent: "a" }],
        batch_id: "not-a-uuid",
      },
    });
    assert.equal(result.isError, true);
  });

  it("forwards optional context per item", async () => {
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [{ decision: "allow", permit_token: "pt_a" }],
        partial: false,
      });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [
          {
            action: "deploy",
            agent: "agent-1",
            context: { environment: "prod" },
          },
        ],
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    assert.deepEqual(items[0].context, { environment: "prod" });
  });
});

// ---------------------------------------------------------------------------
// atlasent_evaluate_stream
// ---------------------------------------------------------------------------

describe("atlasent_evaluate_stream", () => {
  it("buffers SSE and returns the complete batch", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow", permit_token: "p1" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "55555555-5555-4555-8555-555555555555", partial: false })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: { items: [{ action: "deploy", agent: "agent-1" }] },
    });
    const data = parseResult(result);
    assert.equal(data.batch_id, "55555555-5555-4555-8555-555555555555");
    assert.equal((data.items as unknown[]).length, 1);
    assert.equal(data.partial, false);
  });

  it("surfaces per-item error frames and marks partial=true", async () => {
    const sse =
      `event: error\ndata: ${JSON.stringify({ code: "UPSTREAM_TIMEOUT" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "allow" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "66666666-6666-4666-8666-666666666666", partial: true })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: {
        items: [
          { action: "a", agent: "x" },
          { action: "b", agent: "x" },
        ],
      },
    });
    const data = parseResult(result);
    assert.equal(data.partial, true);
    const items = data.items as Array<Record<string, unknown>>;
    assert.ok("error" in items[0]);
  });

  it("surfaces 404 as feature_not_enabled with v2_streaming flag", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_enabled" }, 404));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: { items: [{ action: "deploy", agent: "a" }] },
    });
    const data = parseResult(result);
    assert.equal(data.error, "feature_not_enabled");
    assert.equal(data.flag, "v2_streaming");
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// atlasent_query
// ---------------------------------------------------------------------------

describe("atlasent_query", () => {
  it("returns { data } on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        data: { recentEvaluations: [{ id: "e1" }, { id: "e2" }] },
      }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_query",
      arguments: {
        query: "{ recentEvaluations(limit: 5) { id } }",
      },
    });
    const data = parseResult(result);
    const payload = data.data as Record<string, unknown>;
    assert.equal((payload.recentEvaluations as unknown[]).length, 2);
    assert.equal(result.isError, undefined);
  });

  it("surfaces 404 as feature_not_enabled with v2_graphql flag", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_enabled" }, 404));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_query",
      arguments: { query: "{ activeBundle { id } }" },
    });
    const data = parseResult(result);
    assert.equal(data.error, "feature_not_enabled");
    assert.equal(data.flag, "v2_graphql");
    assert.equal(result.isError, true);
  });

  it("rejects empty query at tool layer", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_query",
      arguments: { query: "" },
    });
    assert.equal(result.isError, true);
  });

  it("forwards variables", async () => {
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return jsonResponse({ data: { recentEvaluations: [] } });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_query",
      arguments: {
        query: "query Q($n: Int!) { recentEvaluations(limit: $n) { id } }",
        variables: { n: 7 },
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.deepEqual(body.variables, { n: 7 });
  });
});
