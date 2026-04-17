#!/usr/bin/env node
/**
 * End-to-end demo: authorization-before-tool-execution.
 *
 * Spawns the MCP server as a child process, connects an MCP client to it over
 * stdio, and drives the full flow for a protected tool (deploy_service):
 *
 *   1. Agent attempts deploy_service (prod, no approvals)   → DENIED, blocked
 *   2. Agent attempts deploy_service (prod, with approvals) → ALLOWED, executes
 *   3. Agent calls verify_permit on the permit_token        → VERIFIED
 *
 * Run with:
 *   npm run build
 *   node examples/demo.mjs
 *
 * Default mode is "local" (no credentials needed). To run against the hosted
 * AtlaSent backend instead:
 *   ATLASENT_MODE=remote ATLASENT_API_KEY=... ATLASENT_BASE_URL=... node examples/demo.mjs
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function section(title) {
  console.log("\n" + "━".repeat(72));
  console.log(title);
  console.log("━".repeat(72));
}

function step(n, description) {
  console.log(`\n[${n}] ${description}`);
}

function show(label, data) {
  console.log(`    ${label}: ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, ATLASENT_MODE: process.env.ATLASENT_MODE ?? "local" },
  });

  const client = new Client({ name: "atlasent-demo", version: "1.0.0" });
  await client.connect(transport);

  section(`AtlaSent MCP demo — mode=${process.env.ATLASENT_MODE ?? "local"}`);

  // -----------------------------------------------------------------------
  // Scenario A — Unauthorized action gets blocked
  // -----------------------------------------------------------------------
  section("Scenario A: agent attempts unauthorized deploy (prod, no approvals)");

  step(1, "Agent calls deploy_service");
  show("request", {
    service_name: "billing-api",
    environment: "production",
    actor_id: "agent-copilot-7",
  });

  const blocked = await client.callTool({
    name: "deploy_service",
    arguments: {
      service_name: "billing-api",
      environment: "production",
      actor_id: "agent-copilot-7",
    },
  });
  const blockedDecision = parse(blocked);

  step(2, "MCP intercepts → calls authorize(ctx) → policy engine decides");
  show("decision", blockedDecision);

  step(3, "Tool execution BLOCKED");
  if (blockedDecision.decision === "deny" || blockedDecision.decision === "hold") {
    console.log("    ✓ deploy did NOT run. The target system was not touched.");
    console.log(`    ✓ reason: ${blockedDecision.reason}`);
  } else {
    console.log("    ✗ UNEXPECTED: decision was not deny/hold. Demo premise failed.");
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Scenario B — Authorized action proceeds
  // -----------------------------------------------------------------------
  section("Scenario B: agent attempts authorized deploy (prod, with approval)");

  step(1, "Agent calls deploy_service with approval");
  show("request", {
    service_name: "billing-api",
    environment: "production",
    actor_id: "agent-copilot-7",
    approvals: ["ticket-42"],
  });

  const allowed = await client.callTool({
    name: "deploy_service",
    arguments: {
      service_name: "billing-api",
      environment: "production",
      actor_id: "agent-copilot-7",
      approvals: ["ticket-42"],
    },
  });
  const allowedDecision = parse(allowed);

  step(2, "MCP intercepts → calls authorize(ctx) → policy engine decides");
  show("decision", {
    decision: allowedDecision.decision,
    permit_token: allowedDecision.permit_token,
    audit_id: allowedDecision.audit_id,
  });

  if (allowedDecision.decision !== "allow") {
    console.log("    ✗ UNEXPECTED: decision was not allow. Demo premise failed.");
    process.exit(1);
  }

  step(3, "Tool execution PROCEEDS");
  show("result", allowedDecision.result);
  console.log("    ✓ deploy executed.");

  // -----------------------------------------------------------------------
  // Scenario C — Close the audit loop
  // -----------------------------------------------------------------------
  section("Scenario C: close the audit loop with verify_permit");

  step(1, "Agent calls verify_permit with the issued token");
  show("request", { permit_token: allowedDecision.permit_token });

  const verified = await client.callTool({
    name: "verify_permit",
    arguments: {
      permit_token: allowedDecision.permit_token,
      action_type: "deploy",
      actor_id: "agent-copilot-7",
      environment: "production",
      approvals: ["ticket-42"],
    },
  });
  const verifyResult = parse(verified);

  step(2, "Verification result");
  show("result", verifyResult);
  if (verifyResult.valid) {
    console.log("    ✓ permit verified. Audit loop closed.");
  } else {
    console.log(`    ✗ permit not valid: ${verifyResult.reason}`);
  }

  // -----------------------------------------------------------------------
  section("Summary");
  console.log(
    [
      `  A. unauthorized deploy: BLOCKED (${blockedDecision.decision})`,
      `  B. authorized deploy:   EXECUTED (${allowedDecision.decision}, service=${allowedDecision.result.service})`,
      `  C. verify_permit:       ${verifyResult.outcome} (valid=${verifyResult.valid})`,
    ].join("\n"),
  );

  await client.close();
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
