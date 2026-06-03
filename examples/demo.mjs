#!/usr/bin/env node
/**
 * End-to-end demo: authorization-before-tool-execution.
 *
 * Spawns the MCP server as a child process, connects an MCP client to it over
 * stdio, and drives the full flow for two use cases:
 *
 * Deploy gate (CI/CD):
 *   A. Agent attempts deploy_service (prod, no approvals)   → DENIED, blocked
 *   B. Agent attempts deploy_service (prod, with approvals) → ALLOWED, executes
 *   C. Agent calls verify_permit on the permit_token        → VERIFIED
 *
 * Agent tool call governance (MCP / AI-native):
 *   D. Agent evaluates agent.db.delete (no change window)   → HOLD, blocked
 *   E. Agent evaluates agent.search.web (safe read)         → ALLOWED, verified
 *
 * AtlaSent governs any action_type — not just deploys. The same evaluate →
 * permit → verify flow that gates CI/CD pipelines also gates your agent's
 * database writes, web searches, and external API calls. Define the actions
 * that matter for your use case; the policy engine handles the rest.
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
      action_type: "production.deploy",
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
  // Scenario D — Agent tool call governance: destructive action held for review
  // -----------------------------------------------------------------------
  section("Scenario D: agent tool governance — db.delete without a change window");

  step(1, "Agent calls evaluate before running agent.db.delete");
  show("request", {
    action_type: "agent.db.delete",
    actor_id: "agent:data-pipeline",
    environment: "development",
  });

  const dbDelete = await client.callTool({
    name: "evaluate",
    arguments: {
      action_type: "agent.db.delete",
      actor_id: "agent:data-pipeline",
      environment: "development",
    },
  });
  const dbDeleteDecision = parse(dbDelete);

  step(2, "MCP intercepts → calls authorize(ctx) → policy engine decides");
  show("decision", dbDeleteDecision);

  step(3, "Tool execution HELD — awaiting human review");
  if (dbDeleteDecision.decision === "hold") {
    console.log("    ✓ database delete did NOT run. Queued for human review.");
    console.log(`    ✓ reason: ${dbDeleteDecision.reason ?? dbDeleteDecision.reasons?.[0]}`);
  } else {
    console.log(`    ! decision was ${dbDeleteDecision.decision} (local policy may differ)`);
  }

  // -----------------------------------------------------------------------
  // Scenario E — Agent tool call governance: safe read action proceeds
  // -----------------------------------------------------------------------
  section("Scenario E: agent tool governance — web search proceeds");

  step(1, "Agent calls evaluate before running agent.search.web");
  show("request", {
    action_type: "agent.search.web",
    actor_id: "agent:research-bot",
    environment: "development",
  });

  const webSearch = await client.callTool({
    name: "evaluate",
    arguments: {
      action_type: "agent.search.web",
      actor_id: "agent:research-bot",
      environment: "development",
    },
  });
  const webSearchDecision = parse(webSearch);

  step(2, "MCP intercepts → calls authorize(ctx) → policy engine decides");
  show("decision", {
    decision: webSearchDecision.decision,
    permit_token: webSearchDecision.permit_token,
    audit_id: webSearchDecision.audit_id,
  });

  if (webSearchDecision.decision !== "allow") {
    console.log(`    ! expected allow but got ${webSearchDecision.decision}. Demo premise failed.`);
    process.exit(1);
  }

  step(3, "Tool execution PROCEEDS — agent searches the web");
  console.log("    ✓ web search authorized.");

  step(4, "Agent calls verify_permit to close the audit loop");
  const webVerified = await client.callTool({
    name: "verify_permit",
    arguments: {
      permit_token: webSearchDecision.permit_token,
      action_type: "agent.search.web",
      actor_id: "agent:research-bot",
      environment: "development",
    },
  });
  const webVerifyResult = parse(webVerified);
  show("result", webVerifyResult);
  if (webVerifyResult.valid) {
    console.log("    ✓ permit verified. Audit loop closed.");
  } else {
    console.log(`    ✗ permit not valid: ${webVerifyResult.reason}`);
  }

  // -----------------------------------------------------------------------
  section("Summary");
  console.log(
    [
      `  A. unauthorized deploy:    BLOCKED (${blockedDecision.decision})`,
      `  B. authorized deploy:      EXECUTED (${allowedDecision.decision}, service=${allowedDecision.result.service})`,
      `  C. verify_permit (deploy): ${verifyResult.outcome} (valid=${verifyResult.valid})`,
      `  D. agent db.delete (hold): ${dbDeleteDecision.decision}`,
      `  E. agent web.search:       EXECUTED (${webSearchDecision.decision}), permit ${webVerifyResult.outcome}`,
    ].join("\n"),
  );
  console.log(
    "\n  AtlaSent governs any action_type — deploy gates, database writes,\n" +
    "  web searches, external API calls, or any action your agent performs.\n",
  );

  await client.close();
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
