import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBatch,
  evaluateStream,
  graphqlQuery,
  FeatureNotEnabledError,
  V2HttpError,
} from "./v2Client.js";

const ITEM = { action: "deploy", agent: "agent-1" };

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

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
  delete process.env.ATLASENT_ANON_KEY;
});

// ---------------------------------------------------------------------------
// evaluateBatch — POST /v1/evaluate/batch
// ---------------------------------------------------------------------------

describe("evaluateBatch", () => {
  it("POSTs items and batch_id, returns the canonical shape", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fn = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [{ decision: "allow", permit_token: "pt_1" }],
        partial: false,
      });
    };
    globalThis.fetch = mock.fn(fn);

    const out = await evaluateBatch({
      items: [ITEM],
      batch_id: "11111111-1111-4111-8111-111111111111",
    });

    assert.equal(out.batch_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(out.partial, false);
    assert.equal(out.items.length, 1);
    assert.equal(captured.length, 1);
    assert.match(captured[0].url, /\/v1\/evaluate\/batch$/);
    const headers = captured[0].init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    const body = JSON.parse(captured[0].init.body as string) as Record<string, unknown>;
    assert.equal(body.batch_id, "11111111-1111-4111-8111-111111111111");
    assert.equal((body.items as unknown[]).length, 1);
  });

  it("throws FeatureNotEnabledError on 404 (closed-by-default)", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_enabled" }, 404));
    await assert.rejects(
      () => evaluateBatch({ items: [ITEM] }),
      (e: unknown) => {
        assert.ok(e instanceof FeatureNotEnabledError);
        assert.equal((e as FeatureNotEnabledError).flag, "v2_batch");
        return true;
      },
    );
  });

  it("rejects empty items array client-side", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}));
    await assert.rejects(() => evaluateBatch({ items: [] }), /non-empty/);
  });

  it("rejects more than 100 items client-side", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}));
    const items = Array.from({ length: 101 }, () => ITEM);
    await assert.rejects(() => evaluateBatch({ items }), /exceeds max 100/);
  });

  it("surfaces 401 as V2HttpError with helpful message", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    await assert.rejects(
      () => evaluateBatch({ items: [ITEM] }),
      (e: unknown) => {
        assert.ok(e instanceof V2HttpError);
        assert.equal((e as V2HttpError).status, 401);
        assert.match((e as Error).message, /Authentication failed/i);
        return true;
      },
    );
  });

  it("surfaces 429 as V2HttpError", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "rate limited" }, 429));
    await assert.rejects(
      () => evaluateBatch({ items: [ITEM] }),
      (e: unknown) => e instanceof V2HttpError && (e as V2HttpError).status === 429,
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateStream — POST /v1/evaluate/stream
// ---------------------------------------------------------------------------

describe("evaluateStream", () => {
  it("buffers SSE frames and returns the complete batch in input order", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow", permit_token: "p1" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "deny", reason: "no approval" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "22222222-2222-4222-8222-222222222222", partial: false })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));

    const out = await evaluateStream({ items: [ITEM, ITEM] });
    assert.equal(out.batch_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(out.partial, false);
    assert.equal(out.items.length, 2);
    const first = out.items[0] as Record<string, unknown>;
    const second = out.items[1] as Record<string, unknown>;
    assert.equal(first.decision, "allow");
    assert.equal(second.decision, "deny");
  });

  it("marks the batch partial and continues when an item emits event:error", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow" })}\n\n` +
      `event: error\ndata: ${JSON.stringify({ code: "UPSTREAM_TIMEOUT" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "allow" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "33333333-3333-4333-8333-333333333333", partial: true })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));

    const out = await evaluateStream({ items: [ITEM, ITEM, ITEM] });
    assert.equal(out.partial, true);
    assert.equal(out.items.length, 3);
    const errItem = out.items[1] as Record<string, unknown>;
    assert.ok("error" in errItem, "second item should be an error frame");
  });

  it("returns FeatureNotEnabledError on 404", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_enabled" }, 404));
    await assert.rejects(
      () => evaluateStream({ items: [ITEM] }),
      (e: unknown) =>
        e instanceof FeatureNotEnabledError &&
        (e as FeatureNotEnabledError).flag === "v2_streaming",
    );
  });

  it("handles SSE frames arriving across chunk boundaries", async () => {
    // Split the SSE body across two stream chunks at an arbitrary byte
    // boundary inside a frame to exercise the buffered parser.
    const part1 = `event: decision\ndata: {"decisi`;
    const part2 =
      `on": "allow"}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "44444444-4444-4444-8444-444444444444", partial: false })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(part1));
        controller.enqueue(new TextEncoder().encode(part2));
        controller.close();
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    globalThis.fetch = mock.fn(async () => res);

    const out = await evaluateStream({ items: [ITEM] });
    assert.equal(out.items.length, 1);
    assert.equal((out.items[0] as Record<string, unknown>).decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// graphqlQuery — POST /v1/graphql
// ---------------------------------------------------------------------------

describe("graphqlQuery", () => {
  it("POSTs query + variables to /v1/graphql and returns { data }", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fn = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        data: { recentEvaluations: [{ id: "e1" }] },
      });
    };
    globalThis.fetch = mock.fn(fn);

    const out = await graphqlQuery({
      query: "query Recent($limit: Int!) { recentEvaluations(limit: $limit) { id } }",
      variables: { limit: 10 },
    });
    assert.ok(out.data);
    assert.match(captured[0].url, /\/v1\/graphql$/);
    const body = JSON.parse(captured[0].init.body as string) as Record<string, unknown>;
    assert.equal(typeof body.query, "string");
    assert.deepEqual(body.variables, { limit: 10 });
  });

  it("returns FeatureNotEnabledError on 404", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_enabled" }, 404));
    await assert.rejects(
      () => graphqlQuery({ query: "{ activeBundle { id } }" }),
      (e: unknown) =>
        e instanceof FeatureNotEnabledError &&
        (e as FeatureNotEnabledError).flag === "v2_graphql",
    );
  });

  it("rejects empty query client-side", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}));
    await assert.rejects(() => graphqlQuery({ query: "" }), /non-empty/);
  });
});
