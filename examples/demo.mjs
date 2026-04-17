#!/usr/bin/env node
/**
 * AtlaSent MCP Server — end-to-end demo
 *
 * Spawns the server in local mode and drives four scenarios:
 *   1. evaluate (staging)            → allow
 *   2. deploy_service (staging)      → allow + execute
 *   3. deploy_service (production)   → hold  (action never runs)
 *   4. verify_permit (from step 2)   → verified
 *   5. read policy resource          → JSON definition
 *
 * Run: npm run demo
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const pass = (label) => console.log(`  \u2713  ${label}`);
const fail = (label, reason) => console.log(`  \u2716  ${label}: ${reason}`);
const section = (label) => console.log(`\n${label}`);

async function main() {
  console.log("AtlaSent MCP Server \u2014 Local Mode Demo\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ATLASENT_MODE: "local" },
  });

  const client = new Client({ name: "atlasent-demo", version: "1.0.0" });
  await client.connect(transport);

  let permitToken;

  try {
    // List available tools
    section("Available tools:");
    const { tools } = await client.listTools();
    for (const tool of tools) {
      console.log(`  \u2022 ${tool.name} \u2014 ${(tool.description ?? "").slice(0, 70)}\u2026`);
    }

    // 1. evaluate staging → allow
    section("Scenario 1: evaluate staging \u2192 expect allow");
    const evalResult = await client.callTool("evaluate", {
      action_type: "deploy",
      actor_id: "github:deploy-bot",
      environment: "staging",
    });
    const evalData = JSON.parse(evalResult.content[0].text);
    if (evalData.decision === "allow") {
      pass(`evaluate \u2192 ${evalData.decision}  permit=${evalData.permit_token}`);
    } else {
      fail("evaluate staging", `expected allow, got ${evalData.decision}`);
    }

    // 2. deploy_service staging → allow + execute
    section("Scenario 2: deploy_service staging \u2192 expect allow + deploy");
    const deployResult = await client.callTool("deploy_service", {
      service_name: "api-gateway",
      environment: "staging",
      actor_id: "github:deploy-bot",
    });
    const deployData = JSON.parse(deployResult.content[0].text);
    permitToken = deployData.permit_token;
    if (deployData.decision === "allow" && deployData.result?.status === "deployed") {
      pass(`deploy_service \u2192 ${deployData.decision}  deployed=${deployData.result.service}@${deployData.result.environment}`);
    } else {
      fail("deploy_service staging", JSON.stringify(deployData));
    }

    // 3. deploy_service production → hold (action blocked)
    section("Scenario 3: deploy_service production \u2192 expect hold/deny (blocked)");
    const prodResult = await client.callTool("deploy_service", {
      service_name: "api-gateway",
      environment: "production",
      actor_id: "github:deploy-bot",
    });
    const prodData = JSON.parse(prodResult.content[0].text);
    if (prodData.decision === "hold" || prodData.decision === "deny") {
      pass(`deploy_service production \u2192 ${prodData.decision}  (deploy code never ran)`);
    } else {
      fail("deploy_service production", `expected hold/deny, got ${prodData.decision}`);
    }

    // 4. verify_permit → close audit loop
    if (permitToken) {
      section("Scenario 4: verify_permit \u2192 expect verified");
      const verifyResult = await client.callTool("verify_permit", {
        permit_token: permitToken,
        action_type: "deploy",
        actor_id: "github:deploy-bot",
        environment: "staging",
      });
      const verifyData = JSON.parse(verifyResult.content[0].text);
      if (verifyData.valid) {
        pass(`verify_permit \u2192 outcome=${verifyData.outcome}  valid=${verifyData.valid}`);
      } else {
        fail("verify_permit", JSON.stringify(verifyData));
      }
    }

    // 5. Read policy resource
    section("Policy resource: atlasent://policies/default");
    const policyRes = await client.readResource("atlasent://policies/default");
    const policyData = JSON.parse(policyRes.contents[0].text);
    pass(`read policy "${policyData.name}"  rules=${policyData.rules?.length ?? 0}`);

    console.log("\nDemo complete.");
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
