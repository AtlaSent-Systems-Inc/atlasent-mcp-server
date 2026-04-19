/**
 * Smoke test: spawns the built `dist/index.js` as a subprocess, drives it over
 * stdio, and asserts the server initializes, lists the 10 v2 tools, and proxies
 * tool calls to a local mock HTTP server with the expected headers.
 *
 * Run via `npm test` (the `pretest` script rebuilds first).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "index.js");

const EXPECTED_TOOLS = [
  "consume_permit",
  "evaluate_action",
  "get_policy",
  "get_report",
  "get_session",
  "list_approvals",
  "list_audit_events",
  "list_policies",
  "resolve_approval",
  "verify_permit",
];

let mockServer;
let mockPort;
let serverProcess;
let rpcId = 0;
const pending = new Map();
const requestsReceived = [];
let stdoutBuffer = "";

function sendRpc(method, params) {
  const id = ++rpcId;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`RPC ${method} (#${id}) timed out`));
    }, 5000);
  });
  serverProcess.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

function sendNotification(method, params) {
  serverProcess.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requestsReceived.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/v1/session") {
        res.end(JSON.stringify({ session_id: "sess_test", role: "admin" }));
      } else if (req.url === "/v1/evaluate") {
        res.end(JSON.stringify({ decision: "allow", permit_id: "p_abc" }));
      } else {
        res.end(JSON.stringify({ echoed_url: req.url, echoed_method: req.method }));
      }
    });
  });
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  mockPort = mockServer.address().port;

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      ATLASENT_API_URL: `http://127.0.0.1:${mockPort}`,
      ATLASENT_API_KEY: "test-key",
      ATLASENT_ORG_ID: "org-test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  serverProcess.stderr.on("data", () => {}); // swallow stderr logs

  serverProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: r, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rj(new Error(msg.error.message));
        else r(msg.result);
      }
    }
  });

  const initResult = await sendRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  assert.equal(initResult.serverInfo.name, "atlasent-mcp-server");
  assert.equal(initResult.serverInfo.version, "2.0.0");
  sendNotification("notifications/initialized");
});

after(async () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  await new Promise((r) => mockServer.close(r));
});

test("tools/list returns the 10 v2 tools", async () => {
  const { tools } = await sendRpc("tools/list");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
});

test("get_session proxies GET /v1/session with the auth header", async () => {
  requestsReceived.length = 0;
  const result = await sendRpc("tools/call", { name: "get_session", arguments: {} });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.session_id, "sess_test");

  assert.equal(requestsReceived.length, 1);
  const [req] = requestsReceived;
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/v1/session");
  assert.equal(req.headers["x-atlasent-key"], "test-key");
  assert.equal(req.headers["x-atlasent-org"], "org-test");
});

test("evaluate_action POSTs /v1/evaluate with the structured body", async () => {
  requestsReceived.length = 0;
  const result = await sendRpc("tools/call", {
    name: "evaluate_action",
    arguments: { actor_id: "u1", action_type: "data:read", target_id: "t1" },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.decision, "allow");

  const [req] = requestsReceived;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/v1/evaluate");
  const body = JSON.parse(req.body);
  assert.equal(body.actor.id, "u1");
  assert.equal(body.action.type, "data:read");
  assert.equal(body.target.id, "t1");
  assert.equal(typeof body.action.id, "string");
});

test("upstream non-2xx surfaces as isError: true", async () => {
  const failingServer = http.createServer((_req, res) => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "forbidden", message: "nope" }));
  });
  await new Promise((r) => failingServer.listen(0, "127.0.0.1", r));
  const failPort = failingServer.address().port;

  const failProc = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      ATLASENT_API_URL: `http://127.0.0.1:${failPort}`,
      ATLASENT_API_KEY: "x",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  failProc.stderr.on("data", () => {});

  const failPending = new Map();
  let failBuf = "";
  failProc.stdout.on("data", (c) => {
    failBuf += c.toString("utf8");
    let i;
    while ((i = failBuf.indexOf("\n")) !== -1) {
      const line = failBuf.slice(0, i).trim();
      failBuf = failBuf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && failPending.has(msg.id)) {
        const { resolve: r } = failPending.get(msg.id);
        failPending.delete(msg.id);
        r(msg.result);
      }
    }
  });

  const send = (method, params) => {
    const id = ++rpcId;
    const p = new Promise((r) => failPending.set(id, { resolve: r }));
    failProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };

  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  failProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const result = await send("tools/call", { name: "get_session", arguments: {} });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /forbidden/);
  assert.match(result.content[0].text, /403/);

  failProc.kill();
  await new Promise((r) => failingServer.close(r));
});
