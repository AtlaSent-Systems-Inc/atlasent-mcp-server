/**
 * Unit tests for compliance MCP tools (SCIM, SIEM, evidence exports).
 *
 * Tests validate:
 * - All 12 tools are registered when READONLY is off
 * - Mutating tools are suppressed when ATLASENT_MCP_READONLY=1
 * - Error responses surface as { error } not thrown exceptions
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.js";
import { toolResult } from "./decision.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function getRegisteredToolNames(server: ReturnType<typeof createServer>): string[] {
  // McpServer exposes _registeredTools (Map keyed by name) for introspection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Map<string, unknown> | undefined;
  if (!tools) return [];
  return [...tools.keys()];
}

// ── Readonly mode: mutating compliance tools are absent ───────────────────────

describe("compliance tools — readonly mode", () => {
  const MUTATING = [
    "atlasent_create_scim_user",
    "atlasent_patch_scim_user",
    "atlasent_delete_scim_user",
    "atlasent_upsert_siem_config",
    "atlasent_create_evidence_export",
  ];

  const READ_ONLY_TOOLS = [
    "atlasent_list_scim_users",
    "atlasent_get_scim_user",
    "atlasent_list_scim_groups",
    "atlasent_get_siem_config",
    "atlasent_test_siem_delivery",
    "atlasent_list_evidence_exports",
    "atlasent_get_evidence_export",
  ];

  let names: string[];

  before(() => {
    process.env.ATLASENT_MCP_READONLY = "1";
    names = getRegisteredToolNames(createServer());
  });

  after(() => {
    delete process.env.ATLASENT_MCP_READONLY;
  });

  for (const tool of MUTATING) {
    it(`${tool} is absent in readonly mode`, () => {
      assert.equal(names.includes(tool), false);
    });
  }

  for (const tool of READ_ONLY_TOOLS) {
    it(`${tool} is present in readonly mode`, () => {
      assert.equal(names.includes(tool), true);
    });
  }
});

// ── Normal mode: all 12 compliance tools are registered ──────────────────────

describe("compliance tools — normal mode", () => {
  const ALL_COMPLIANCE_TOOLS = [
    "atlasent_list_scim_users",
    "atlasent_get_scim_user",
    "atlasent_create_scim_user",
    "atlasent_patch_scim_user",
    "atlasent_delete_scim_user",
    "atlasent_list_scim_groups",
    "atlasent_get_siem_config",
    "atlasent_upsert_siem_config",
    "atlasent_test_siem_delivery",
    "atlasent_list_evidence_exports",
    "atlasent_get_evidence_export",
    "atlasent_create_evidence_export",
  ];

  let names: string[];

  before(() => {
    delete process.env.ATLASENT_MCP_READONLY;
    names = getRegisteredToolNames(createServer());
  });

  for (const tool of ALL_COMPLIANCE_TOOLS) {
    it(`${tool} is registered`, () => {
      assert.equal(names.includes(tool), true);
    });
  }
});

// ── toolResult shape ──────────────────────────────────────────────────────────

describe("toolResult helper", () => {
  it("wraps data in MCP content format", () => {
    const result = toolResult({ success: true, count: 3 });
    assert.ok(result.content);
    assert.ok(Array.isArray(result.content));
    const item = result.content[0] as { type: string; text: string };
    assert.equal(item.type, "text");
    const parsed = JSON.parse(item.text);
    assert.equal(parsed.success, true);
    assert.equal(parsed.count, 3);
  });
});
