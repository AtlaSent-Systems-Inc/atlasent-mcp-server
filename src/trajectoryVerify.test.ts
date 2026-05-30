import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { trajectoryVerify } from "./trajectoryVerify.js";

const BASE_OPTS = {
  apiKey: "test-key",
  baseUrl: "https://api.test",
  permitToken: "pt_traj_001",
  currentStep: "fetch_customer_records",
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: object, status = 200) {
  return mock.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ---------------------------------------------------------------------------
// Happy path: on_trajectory=true
// ---------------------------------------------------------------------------

describe("trajectoryVerify — success response", () => {
  it("returns on_trajectory=true for a 200 response", async () => {
    globalThis.fetch = mockFetch({
      on_trajectory: true,
      trajectory_position: 1,
      trajectory_complete: false,
      verified_at: "2026-05-30T10:00:00.000Z",
    });
    const result = await trajectoryVerify(BASE_OPTS);
    assert.equal(result.on_trajectory, true);
    assert.equal(result.trajectory_position, 1);
    assert.equal(result.trajectory_complete, false);
    assert.equal(result.verified_at, "2026-05-30T10:00:00.000Z");
    assert.equal(result.deviation, undefined);
  });

  it("passes completedSteps and executionContext in the request body", async () => {
    const captured: { body: unknown; url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(url),
        body: JSON.parse((init?.body as string) ?? "{}"),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(
        JSON.stringify({
          on_trajectory: true,
          trajectory_complete: false,
          verified_at: "2026-05-30T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await trajectoryVerify({
      ...BASE_OPTS,
      completedSteps: ["validate_inputs", "auth_check"],
      executionContext: { session_id: "sess_42" },
    });

    assert.equal(captured.length, 1);
    const req = captured[0];
    const body = req.body as Record<string, unknown>;
    assert.equal(body.permit_token, "pt_traj_001");
    assert.equal(body.current_step, "fetch_customer_records");
    assert.deepEqual(body.completed_steps, ["validate_inputs", "auth_check"]);
    assert.deepEqual(body.execution_context, { session_id: "sess_42" });
  });
});

// ---------------------------------------------------------------------------
// Deviation: on_trajectory=false (does NOT throw — returns the result)
// ---------------------------------------------------------------------------

describe("trajectoryVerify — deviation response", () => {
  it("returns on_trajectory=false for a deviation 200 response without throwing", async () => {
    globalThis.fetch = mockFetch({
      on_trajectory: false,
      trajectory_complete: false,
      verified_at: "2026-05-30T10:00:01.000Z",
      deviation: { reason: "step not in approved plan", trajectory_id: "traj_999" },
    });
    const result = await trajectoryVerify(BASE_OPTS);
    assert.equal(result.on_trajectory, false);
    assert.equal(result.trajectory_complete, false);
    assert.ok(result.deviation, "deviation must be present");
    assert.equal(result.deviation?.reason, "step not in approved plan");
    assert.equal(result.deviation?.trajectory_id, "traj_999");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: network errors swallowed, returns on_trajectory=false
// ---------------------------------------------------------------------------

describe("trajectoryVerify — fail-closed on network errors", () => {
  it("returns on_trajectory=false and swallows network errors", async () => {
    globalThis.fetch = mock.fn(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });
    const result = await trajectoryVerify(BASE_OPTS);
    assert.equal(result.on_trajectory, false);
    assert.equal(result.trajectory_complete, false);
    assert.ok(result.deviation, "deviation must be present on network error");
    assert.match(result.deviation!.reason, /ECONNREFUSED/);
    assert.ok(result.verified_at, "verified_at must be set");
  });

  it("returns on_trajectory=false on HTTP 500 without throwing", async () => {
    globalThis.fetch = mockFetch({ error: "internal_server_error" }, 500);
    const result = await trajectoryVerify(BASE_OPTS);
    assert.equal(result.on_trajectory, false);
    assert.equal(result.trajectory_complete, false);
    assert.ok(result.deviation, "deviation must be present on HTTP 5xx");
  });

  it("returns on_trajectory=false on AbortError (timeout) without throwing", async () => {
    globalThis.fetch = mock.fn(async (): Promise<Response> => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      throw err;
    });
    const result = await trajectoryVerify(BASE_OPTS);
    assert.equal(result.on_trajectory, false);
    assert.equal(result.trajectory_complete, false);
    assert.ok(result.deviation?.reason, "deviation reason must be set");
  });
});

// ---------------------------------------------------------------------------
// Correct URL and auth headers
// ---------------------------------------------------------------------------

describe("trajectoryVerify — correct URL and auth headers", () => {
  it("calls the correct URL with correct Authorization header", async () => {
    const captured: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(
        JSON.stringify({ on_trajectory: true, trajectory_complete: false, verified_at: "2026-05-30T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await trajectoryVerify({
      apiKey: "sk_live_abc123",
      baseUrl: "https://api.atlasent.io",
      permitToken: "pt_traj_xxx",
      currentStep: "write_audit_log",
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://api.atlasent.io/v1/trajectory-verify");
    assert.equal(captured[0].headers["Authorization"], "Bearer sk_live_abc123");
    assert.equal(captured[0].headers["Content-Type"], "application/json");
  });

  it("strips trailing slash from baseUrl before constructing the path", async () => {
    const captured: { url: string }[] = [];
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      captured.push({ url: String(url) });
      return new Response(
        JSON.stringify({ on_trajectory: true, trajectory_complete: false, verified_at: "2026-05-30T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await trajectoryVerify({
      ...BASE_OPTS,
      baseUrl: "https://api.atlasent.io/",
    });

    assert.equal(captured[0].url, "https://api.atlasent.io/v1/trajectory-verify");
  });
});

// ---------------------------------------------------------------------------
// 10-second AbortSignal timeout is wired in
// ---------------------------------------------------------------------------

describe("trajectoryVerify — AbortSignal timeout", () => {
  it("passes an AbortSignal with a timeout to fetch", async () => {
    let capturedSignal: AbortSignal | null | undefined = undefined;
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response(
        JSON.stringify({ on_trajectory: true, trajectory_complete: false, verified_at: "2026-05-30T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await trajectoryVerify(BASE_OPTS);

    assert.ok(capturedSignal !== undefined, "signal must be passed to fetch");
    assert.ok(capturedSignal instanceof AbortSignal, "signal must be an AbortSignal");
  });
});
