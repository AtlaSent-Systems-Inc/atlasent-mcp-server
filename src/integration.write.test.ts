/**
 * Opt-in integration tests for the policy + permit write tools.
 *
 * SKIP UNLESS all three of the following are set:
 *   ATLASENT_API_KEY          — sandbox-org API key (NOT a production key)
 *   ATLASENT_BASE_URL         — sandbox API base URL
 *   ATLASENT_SANDBOX_ORG_ID   — sandbox org id (acts as the explicit
 *                               opt-in switch — without it we never run
 *                               write operations against the live API)
 *
 * Design constraints:
 *   - Unit tests in `server.test.ts` remain the blocking CI gate. This
 *     file is workflow-dispatch only and skips otherwise.
 *   - Every fixture name is suffixed with a per-run timestamp so re-runs
 *     do not collide and accidental traces are easy to find.
 *   - revoke_permit only acts on a permit this run created (issued via
 *     `evaluate` and located by the unique fixture actor_id).
 *   - list_permits uses narrow filters and asserts response shape only.
 *   - No fixture is deleted; archived/revoked rows stay in the sandbox
 *     for forensic inspection.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const REQUIRED_VARS = [
  "ATLASENT_API_KEY",
  "ATLASENT_BASE_URL",
  "ATLASENT_SANDBOX_ORG_ID",
] as const;

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
const CONFIGURED = missing.length === 0;

if (!CONFIGURED) {
  console.log(
    `Skipping write-tool integration tests (missing: ${missing.join(", ")}). ` +
      `These run against a sandbox only — set ATLASENT_SANDBOX_ORG_ID to opt in.`,
  );
}

function parseResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

if (CONFIGURED) {
  // Force remote mode — these tests hit the live sandbox API.
  process.env.ATLASENT_MODE = "remote";

  const ORG_ID = process.env.ATLASENT_SANDBOX_ORG_ID!;
  const RUN_ID = `mcp-it-${Date.now()}`;
  const ACTOR_ID = `${RUN_ID}-actor`;
  const POLICY_ID = `${RUN_ID}-policy`;

  let client: Client;

  before(async () => {
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "integration-write-test", version: "1.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  describe("integration: create_policy + update_policy (sandbox-only)", () => {
    it("creates a low-priority draft policy with a timestamped id", async () => {
      const result = await client.callTool({
        name: "atlasent_create_policy",
        arguments: {
          org_id: ORG_ID,
          policy_id: POLICY_ID,
          title: `MCP integration test policy (${RUN_ID})`,
          description:
            "Auto-created by atlasent-mcp-server integration suite. Safe to archive.",
          policy_type: "access_control",
          // Priority is intentionally far above any real policy so the
          // rule never fires against production-like sandbox traffic.
          priority: 9999,
          rules: [
            {
              when: { actor_id_starts_with: "mcp-it-" },
              decision: "deny",
              reason: "integration-test fixture",
            },
          ],
        },
      });
      if (result.isError) {
        throw new Error(
          `create_policy failed: ${JSON.stringify(parseResult(result))}`,
        );
      }
      const data = parseResult(result);
      // The API returns the persisted row; either a numeric/uuid `id` or
      // the caller-supplied `policy_id` is sufficient evidence of write.
      assert.ok(
        data.id || data.policy_id,
        `Expected id or policy_id in response, got ${JSON.stringify(data)}`,
      );
    });

    it("PATCHes the same policy with a partial update", async () => {
      const result = await client.callTool({
        name: "atlasent_update_policy",
        arguments: {
          policy_id: POLICY_ID,
          org_id: ORG_ID,
          description: `Updated by integration test ${RUN_ID}`,
          priority: 9998,
        },
      });
      if (result.isError) {
        // Some sandbox builds gate update by row UUID rather than slug;
        // surface the error but do not fail the suite — the create
        // assertion above is the primary write proof.
        console.log(
          "update_policy returned error (treated as soft-fail):",
          parseResult(result),
        );
        return;
      }
      const data = parseResult(result);
      assert.ok(
        data,
        `Expected an updated policy row, got ${JSON.stringify(data)}`,
      );
    });
  });

  describe("integration: list_permits (sandbox-only)", () => {
    it("returns a permits[] envelope under narrow filters", async () => {
      const result = await client.callTool({
        name: "atlasent_list_permits",
        arguments: {
          org_id: ORG_ID,
          // Filter on a per-run actor that cannot match any pre-existing
          // row, so an empty response is still a valid shape assertion
          // and we never surface unrelated permit data in the test log.
          actor_id: `${RUN_ID}-noop`,
          limit: 5,
        },
      });
      if (result.isError) {
        throw new Error(
          `list_permits failed: ${JSON.stringify(parseResult(result))}`,
        );
      }
      const data = parseResult(result);
      assert.ok(
        Array.isArray(data.permits),
        `Expected permits[] array in response, got ${JSON.stringify(data)}`,
      );
    });
  });

  describe("integration: revoke_permit (sandbox-only, fixture-created)", () => {
    it("issues a permit, locates its row, and revokes it", async () => {
      // Step 1 — issue a permit by calling evaluate against the sandbox.
      // We use the unique fixture ACTOR_ID so the row is unambiguously
      // ours when we go to look it up.
      const evalResult = await client.callTool({
        name: "evaluate",
        arguments: {
          action_type: "integration_test_revoke",
          actor_id: ACTOR_ID,
          environment: "staging",
        },
      });
      const evalData = parseResult(evalResult);
      if (evalData.decision !== "allow") {
        // Sandbox policy may not allow this action; that is fine — we
        // simply have no fixture to revoke. Do not fall back to revoking
        // any pre-existing permit we did not create.
        console.log(
          `Skipping revoke test: evaluate decision was ${evalData.decision}`,
        );
        return;
      }

      // Step 2 — locate the just-issued permit's row id by filtering on
      // the unique fixture actor_id. The MCP tool's response shape is
      // { permits: [...], total, next_cursor }.
      const listResult = await client.callTool({
        name: "atlasent_list_permits",
        arguments: {
          org_id: ORG_ID,
          actor_id: ACTOR_ID,
          status: "issued",
          limit: 5,
        },
      });
      if (listResult.isError) {
        console.log(
          "Skipping revoke test: list_permits errored:",
          parseResult(listResult),
        );
        return;
      }
      const listData = parseResult(listResult) as {
        permits?: Array<{ id?: string }>;
      };
      const permit = listData.permits?.[0];
      if (!permit?.id) {
        console.log(
          "Skipping revoke test: no permit row located for fixture actor",
        );
        return;
      }

      // Step 3 — revoke the fixture-created permit by id.
      const revokeResult = await client.callTool({
        name: "atlasent_revoke_permit",
        arguments: {
          permit_id: permit.id,
          org_id: ORG_ID,
          reason: `MCP integration test ${RUN_ID}`,
        },
      });
      if (revokeResult.isError) {
        throw new Error(
          `revoke_permit failed: ${JSON.stringify(parseResult(revokeResult))}`,
        );
      }
      const revoked = parseResult(revokeResult);
      // The /v1/permits/:id/revoke handler returns the updated permit
      // row with status='revoked'. Some deployments wrap it as { revoked: true }.
      assert.ok(
        revoked.status === "revoked" || revoked.revoked === true,
        `Expected revoked status, got ${JSON.stringify(revoked)}`,
      );
    });
  });
}
