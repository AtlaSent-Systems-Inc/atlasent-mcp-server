#!/usr/bin/env node
/**
 * End-to-end demo: execution-time authorization with Permit Verification
 * before the protected native effect.
 *
 * Scenarios:
 *   A. production deployment without required approval → DENY, no execution
 *   B. production deployment with approval → authorize + verify → execute
 *   C. generic agent.tool.invoke → evaluate → verify → simulated tool effect
 *   D. replay the consumed tool Permit → invalid, proving single-use behavior
 *
 * Default mode is local (development/demo only). To point the same flow at the
 * hosted runtime, set ATLASENT_MODE=remote plus credentials/base URL.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "index.js");

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

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, ATLASENT_MODE: process.env.ATLASENT_MODE ?? "local" },
  });

  const client = new Client({ name: "atlasent-demo", version: "1.0.0" });
  await client.connect(transport);

  section(`AtlaSent MCP demo — mode=${process.env.ATLASENT_MODE ?? "local"}`);
  console.log("A plausible request is not organizational authority.");
  console.log("Protected effects follow: Authority/Policy → Evaluation → Permit → Verification → Execution → Evidence.");

  // -----------------------------------------------------------------------
  // Scenario A — unauthorized production deployment is blocked
  // -----------------------------------------------------------------------
  section("Scenario A: production deployment without required approval");

  step(1, "Agent calls deploy_service");
  const blocked = await client.callTool({
    name: "deploy_service",
    arguments: {
      service_name: "billing-api",
      environment: "production",
      actor_id: "agent-copilot-7",
    },
  });
  const blockedDecision = parse(blocked);
  show("decision", blockedDecision);

  step(2, "No authorized + verified path → native deployment remains blocked");
  if (blockedDecision.decision === "deny" || blockedDecision.decision === "hold") {
    console.log("    ✓ deploy did NOT run. No native result was produced.");
  } else {
    console.log("    ✗ UNEXPECTED: unauthorized production deployment was not blocked.");
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Scenario B — protected deployment verifies before execution
  // -----------------------------------------------------------------------
  section("Scenario B: approved production deployment verifies before execution");

  step(1, "Agent calls deploy_service with the required approval evidence");
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

  show("decision", {
    decision: allowedDecision.decision,
    audit_id: allowedDecision.audit_id,
  });
  show("execution-boundary verification", allowedDecision.verification);

  if (allowedDecision.decision !== "allow" || !allowedDecision.verification?.valid) {
    console.log("    ✗ UNEXPECTED: protected deployment did not pass authorization + verification.");
    process.exit(1);
  }

  step(2, "Only after Verification does deploy_service produce the native result");
  show("result", allowedDecision.result);
  if (allowedDecision.result?.status !== "deployed") {
    console.log("    ✗ UNEXPECTED: verified deployment produced no native result.");
    process.exit(1);
  }
  console.log("    ✓ deployment executed after Permit Verification.");

  // -----------------------------------------------------------------------
  // Scenario C — generic agent tool Action uses the same Gate ordering
  // -----------------------------------------------------------------------
  section("Scenario C: generic agent.tool.invoke is verified before the tool effect");

  step(1, "Evaluate the Canon-backed agent.tool.invoke Action");
  const toolEvaluation = await client.callTool({
    name: "evaluate",
    arguments: {
      action_type: "agent.tool.invoke",
      actor_id: "agent:research-bot",
      environment: "development",
    },
  });
  const toolDecision = parse(toolEvaluation);
  show("decision", toolDecision);

  if (toolDecision.decision !== "allow" || !toolDecision.permit_token) {
    console.log(`    ✗ expected allow with Permit; got ${toolDecision.decision}`);
    process.exit(1);
  }

  step(2, "Verify the Permit at the execution boundary BEFORE invoking the tool");
  const toolVerification = await client.callTool({
    name: "verify_permit",
    arguments: {
      permit_token: toolDecision.permit_token,
      action_type: "agent.tool.invoke",
      actor_id: "agent:research-bot",
      environment: "development",
    },
  });
  const toolVerifyResult = parse(toolVerification);
  show("verification", toolVerifyResult);

  if (!toolVerifyResult.valid) {
    console.log("    ✗ Permit did not verify; tool effect remains blocked.");
    process.exit(1);
  }

  step(3, "Verification succeeded → simulated native tool effect may now run");
  const simulatedToolResult = { status: "completed", tool: "research.search", records: 3 };
  show("native result", simulatedToolResult);
  console.log("    ✓ tool effect occurred after Verification, not before it.");

  // -----------------------------------------------------------------------
  // Scenario D — single-use Permit replay is rejected
  // -----------------------------------------------------------------------
  section("Scenario D: replay of the consumed agent.tool.invoke Permit is rejected");

  const replay = await client.callTool({
    name: "verify_permit",
    arguments: {
      permit_token: toolDecision.permit_token,
      action_type: "agent.tool.invoke",
      actor_id: "agent:research-bot",
      environment: "development",
    },
  });
  const replayResult = parse(replay);
  show("replay verification", replayResult);
  if (replayResult.valid) {
    console.log("    ✗ UNEXPECTED: consumed Permit verified twice.");
    process.exit(1);
  }
  console.log("    ✓ replay refused; Permit is single-use in the demo runtime.");

  section("Summary");
  console.log(
    [
      `  A. unauthorized deployment: BLOCKED (${blockedDecision.decision})`,
      `  B. approved deployment:     VERIFIED → EXECUTED (${allowedDecision.result.status})`,
      `  C. agent.tool.invoke:        VERIFIED → EXECUTED (${simulatedToolResult.status})`,
      `  D. Permit replay:            REFUSED (${replayResult.outcome})`,
    ].join("\n"),
  );
  console.log(
    "\n  Stable rule: Evaluation is not execution. An allow Decision can issue a\n" +
    "  bounded Permit; the Gate verifies that Permit before the governed native effect.\n",
  );

  await client.close();
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
