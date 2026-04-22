#!/usr/bin/env node
/**
 * End-to-end demo: authorization-before-tool-execution.
 *
 * Spawns the MCP server as a child process, connects an MCP client to it over
 * stdio, and walks through a set of high-signal scenarios:
 *
 *   1. send_email to an EXTERNAL recipient            → BLOCKED
 *   2. send_email to an INTERNAL recipient            → ALLOWED, sends
 *   3. access_sensitive_dataset (PII, no approval)    → BLOCKED
 *   4. access_sensitive_dataset (public dataset)      → ALLOWED, reads
 *   5. write_to_production (no approval)              → BLOCKED
 *   6. write_to_production (with approval)            → ALLOWED, writes
 *   7. verify_permit on the write's permit_token      → VERIFIED
 *
 * Run with:
 *   npm run build
 *   npm run demo
 *
 * Default mode is "local" (no credentials needed). To run against the hosted
 * AtlaSent backend instead:
 *   ATLASENT_MODE=remote ATLASENT_API_KEY=... ATLASENT_BASE_URL=... npm run demo
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

/**
 * Tool results now carry TWO text blocks: a human-readable banner and a
 * structured JSON payload. Parse the JSON from the last block.
 */
function parse(result) {
  const blocks = result.content ?? [];
  const json = blocks[blocks.length - 1]?.text ?? "{}";
  return JSON.parse(json);
}

function banner(result) {
  const blocks = result.content ?? [];
  return blocks[0]?.text ?? "";
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

function expectBlocked(result, label) {
  const data = parse(result);
  if (data.decision === "deny" || data.decision === "hold") {
    console.log(`    ${banner(result)}`);
    return data;
  }
  console.log(`    ✗ UNEXPECTED: ${label} was not blocked (decision=${data.decision}). Demo premise failed.`);
  process.exit(1);
}

function expectAllowed(result, label) {
  const data = parse(result);
  if (data.decision === "allow") {
    console.log(`    ${banner(result)}`);
    return data;
  }
  console.log(`    ✗ UNEXPECTED: ${label} was not allowed (decision=${data.decision}). Demo premise failed.`);
  process.exit(1);
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
  console.log(
    "AtlaSent is the authorization boundary. Every protected tool calls\n" +
      "authorize() BEFORE running. If the decision isn't 'allow', the tool\n" +
      "code never executes — the target system is not touched.",
  );

  // -----------------------------------------------------------------------
  // 1. send_email — external recipient, no approval → BLOCKED
  // -----------------------------------------------------------------------
  section("1. send_email → external recipient, no approval (should be BLOCKED)");
  step(1, "Agent calls send_email");
  show("request", {
    to: "ceo@competitor.com",
    subject: "Proposal",
    actor_id: "agent-copilot-7",
  });
  step(2, "MCP intercepts → authorize(ctx) → policy decides");
  const emailBlocked = await client.callTool({
    name: "send_email",
    arguments: {
      to: "ceo@competitor.com",
      subject: "Proposal",
      body: "Draft proposal attached.",
      actor_id: "agent-copilot-7",
    },
  });
  const blockedEmail = expectBlocked(emailBlocked, "external email");
  show("reason", blockedEmail.reason);
  console.log("    ✓ email did NOT leave the system.");

  // -----------------------------------------------------------------------
  // 2. send_email — internal recipient → ALLOWED
  // -----------------------------------------------------------------------
  section("2. send_email → internal recipient (should be ALLOWED)");
  step(1, "Agent calls send_email");
  show("request", {
    to: "alice@acme.corp",
    subject: "Weekly status",
    actor_id: "agent-copilot-7",
  });
  step(2, "MCP intercepts → authorize(ctx) → policy decides");
  const emailAllowed = await client.callTool({
    name: "send_email",
    arguments: {
      to: "alice@acme.corp",
      subject: "Weekly status",
      body: "See attached.",
      actor_id: "agent-copilot-7",
    },
  });
  const allowedEmail = expectAllowed(emailAllowed, "internal email");
  show("result", allowedEmail.result);

  // -----------------------------------------------------------------------
  // 3. access_sensitive_dataset — PII, no approval → BLOCKED
  // -----------------------------------------------------------------------
  section("3. access_sensitive_dataset → PII, no approval (should be BLOCKED)");
  step(1, "Agent calls access_sensitive_dataset");
  show("request", {
    dataset_id: "customers_pii",
    purpose: "cohort analysis",
    actor_id: "agent-analyst",
  });
  step(2, "MCP intercepts → authorize(ctx) → policy decides");
  const pii = await client.callTool({
    name: "access_sensitive_dataset",
    arguments: {
      dataset_id: "customers_pii",
      purpose: "cohort analysis",
      actor_id: "agent-analyst",
    },
  });
  const blockedPii = expectBlocked(pii, "PII dataset read");
  show("reason", blockedPii.reason);
  console.log("    ✓ zero rows returned to the agent.");

  // -----------------------------------------------------------------------
  // 4. access_sensitive_dataset — public dataset → ALLOWED
  // -----------------------------------------------------------------------
  section("4. access_sensitive_dataset → public dataset (should be ALLOWED)");
  const publicDataset = await client.callTool({
    name: "access_sensitive_dataset",
    arguments: {
      dataset_id: "public_benchmarks",
      purpose: "report",
      actor_id: "agent-analyst",
    },
  });
  const allowedPublic = expectAllowed(publicDataset, "public dataset read");
  show("rows", allowedPublic.result.row_count);

  // -----------------------------------------------------------------------
  // 5. write_to_production — no approval → BLOCKED
  // -----------------------------------------------------------------------
  section("5. write_to_production → no approval (should be BLOCKED)");
  step(1, "Agent calls write_to_production");
  show("request", {
    system: "billing-db",
    operation: "apply_refund",
    environment: "production",
    actor_id: "agent-ops",
  });
  step(2, "MCP intercepts → authorize(ctx) → policy decides");
  const writeBlocked = await client.callTool({
    name: "write_to_production",
    arguments: {
      system: "billing-db",
      operation: "apply_refund",
      payload: { customer_id: "cust_42", amount_cents: 12500 },
      environment: "production",
      actor_id: "agent-ops",
    },
  });
  const blockedWrite = expectBlocked(writeBlocked, "prod write");
  show("reason", blockedWrite.reason);
  console.log("    ✓ billing-db was NOT written.");

  // -----------------------------------------------------------------------
  // 6. write_to_production — with approval → ALLOWED
  // -----------------------------------------------------------------------
  section("6. write_to_production → with approval (should be ALLOWED)");
  const writeAllowed = await client.callTool({
    name: "write_to_production",
    arguments: {
      system: "billing-db",
      operation: "apply_refund",
      payload: { customer_id: "cust_42", amount_cents: 12500 },
      environment: "production",
      actor_id: "agent-ops",
      approvals: ["ticket-42", "reviewer:alice"],
    },
  });
  const allowedWrite = expectAllowed(writeAllowed, "prod write w/ approval");
  show("result", allowedWrite.result);
  show("permit_token", allowedWrite.permit_token);

  // -----------------------------------------------------------------------
  // 7. Close the audit loop
  // -----------------------------------------------------------------------
  section("7. verify_permit → close the audit loop");
  const verified = await client.callTool({
    name: "verify_permit",
    arguments: {
      permit_token: allowedWrite.permit_token,
      action_type: "write",
      actor_id: "agent-ops",
      environment: "production",
      approvals: ["ticket-42", "reviewer:alice"],
    },
  });
  const verifyData = parse(verified);
  console.log(`    ${banner(verified)}`);
  show("result", verifyData);

  // -----------------------------------------------------------------------
  section("Summary");
  console.log(
    [
      "  1. send_email (external)        → BLOCKED",
      "  2. send_email (internal)        → ALLOWED",
      "  3. access_dataset (PII)         → BLOCKED",
      "  4. access_dataset (public)      → ALLOWED",
      "  5. write_to_production (no appr)→ BLOCKED",
      "  6. write_to_production (appr)   → ALLOWED",
      `  7. verify_permit                → ${verifyData.outcome} (valid=${verifyData.valid})`,
    ].join("\n"),
  );

  await client.close();
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
