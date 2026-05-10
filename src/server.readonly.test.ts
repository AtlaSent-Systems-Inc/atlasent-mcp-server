/**
 * Readonly-mode tests. Verifies that ATLASENT_MCP_READONLY=1 hides the
 * 7 mutating tools from tools/list and that the demo flow + read tools
 * + approval workflow remain available.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createServer,
  isToolDisabledByReadOnly,
  _resetRateLimitForTests,
} from "./server.js";

const DISABLED_IN_READONLY = [
  "atlasent_create_policy",
  "atlasent_update_policy",
  "atlasent_delete_policy",
  "atlasent_create_webhook",
  "atlasent_delete_webhook",
  "atlasent_revoke_permit",
  "atlasent_permit",
];

const STILL_AVAILABLE_IN_READONLY = [
  "evaluate",
  "verify_permit",
  "deploy_service",
  "atlasent_evaluate",
  "atlasent_verify_permit",
  "atlasent_list_policies",
  "atlasent_get_policy",
  "atlasent_list_audit_events",
  "atlasent_list_permits",
  "atlasent_create_approval_request",
  "atlasent_resolve_approval_request",
  "atlasent_record_execution_evaluation",
];

async function setup() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "readonly-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

beforeEach(() => {
  _resetRateLimitForTests();
  delete process.env.ATLASENT_MCP_READONLY;
});

afterEach(() => {
  delete process.env.ATLASENT_MCP_READONLY;
});

describe("isToolDisabledByReadOnly()", () => {
  it("returns false when the flag is unset", () => {
    delete process.env.ATLASENT_MCP_READONLY;
    for (const t of DISABLED_IN_READONLY) {
      assert.equal(isToolDisabledByReadOnly(t), false, t);
    }
  });

  it("returns true for mutating tools when flag=1", () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    for (const t of DISABLED_IN_READONLY) {
      assert.equal(isToolDisabledByReadOnly(t), true, t);
    }
  });

  it("returns true for mutating tools when flag=true", () => {
    process.env.ATLASENT_MCP_READONLY = "true";
    for (const t of DISABLED_IN_READONLY) {
      assert.equal(isToolDisabledByReadOnly(t), true, t);
    }
  });

  it("returns false for non-mutating tools even when flag=1", () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    for (const t of STILL_AVAILABLE_IN_READONLY) {
      assert.equal(isToolDisabledByReadOnly(t), false, t);
    }
  });

  it("treats unrecognized values as unset (no gating)", () => {
    for (const v of ["0", "false", "yes", "", "no"]) {
      process.env.ATLASENT_MCP_READONLY = v;
      for (const t of DISABLED_IN_READONLY) {
        assert.equal(isToolDisabledByReadOnly(t), false, `${t} with flag=${v}`);
      }
    }
  });
});

describe("tools/list with ATLASENT_MCP_READONLY=1", () => {
  it("hides all 7 mutating tools", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const t of DISABLED_IN_READONLY) {
      assert.equal(names.has(t), false, `${t} should NOT be registered in readonly mode`);
    }
  });

  it("keeps the demo flow + read tools + approval workflow available", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const t of STILL_AVAILABLE_IN_READONLY) {
      assert.equal(names.has(t), true, `${t} MUST stay registered in readonly mode`);
    }
  });

  it("registers exactly 12 tools (19 - 7)", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
  });
});

describe("tools/list with ATLASENT_MCP_READONLY unset (default)", () => {
  it("registers all 19 tools (no regression)", async () => {
    delete process.env.ATLASENT_MCP_READONLY;
    const { client } = await setup();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 19);
    const names = new Set(tools.map((t) => t.name));
    for (const t of [...DISABLED_IN_READONLY, ...STILL_AVAILABLE_IN_READONLY]) {
      assert.equal(names.has(t), true, `${t} should be registered by default`);
    }
  });
});

describe("calling a gated tool by name when readonly", () => {
  it("returns a Method not found error (tool isn't registered)", async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    const { client } = await setup();
    // The MCP SDK throws on unknown tools rather than returning isError.
    await assert.rejects(
      () =>
        client.callTool({
          name: "atlasent_delete_policy",
          arguments: { policy_id: "x", org_id: "y" },
        }),
      /tool|not found|unknown/i,
    );
  });
});
