import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const REQUIRED_VARS = ["ATLASENT_API_KEY", "ATLASENT_BASE_URL"];

function skipUnlessConfigured(): void {
  for (const v of REQUIRED_VARS) {
    if (!process.env[v]) {
      console.log(`Skipping integration tests: ${v} not set`);
      process.exit(0);
    }
  }
  // Force remote mode — integration tests hit the live hosted backend.
  process.env.ATLASENT_MODE = "remote";
}

let client: Client;

before(async () => {
  skipUnlessConfigured();
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "integration-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("integration: evaluate → verify_permit", () => {
  let permitToken: string;

  it("evaluate returns a decision from the live API", async () => {
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "integration_test",
        actor_id: "ci-test-runner",
        environment: "staging",
      },
    });
    const data = parseResult(result);

    assert.ok(
      ["allow", "deny", "hold"].includes(data.decision as string),
      `Unexpected decision: ${data.decision}`,
    );

    if (data.decision === "allow") {
      assert.ok(data.permit_token, "Expected permit_token when decision is allow");
      permitToken = data.permit_token as string;
    }
  });

  it("verify_permit confirms the permit against the live API", async () => {
    if (!permitToken) {
      console.log("Skipping: evaluate did not return allow, no permit to verify");
      return;
    }

    const result = await client.callTool({
      name: "verify_permit",
      arguments: {
        permit_token: permitToken,
        action_type: "integration_test",
        actor_id: "ci-test-runner",
        environment: "staging",
      },
    });
    const data = parseResult(result);

    assert.ok(typeof data.valid === "boolean", `Expected valid to be boolean, got ${typeof data.valid}`);
    assert.ok(data.outcome, "Expected outcome to be present");
  });
});

describe("integration: fail-closed on bad credentials", () => {
  it("denies when API key is invalid", async () => {
    const saved = process.env.ATLASENT_API_KEY;
    process.env.ATLASENT_API_KEY = "invalid_key_for_testing";

    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const badClient = new Client({ name: "bad-creds-test", version: "1.0.0" });
    await Promise.all([badClient.connect(ct), server.connect(st)]);

    const result = await badClient.callTool({
      name: "evaluate",
      arguments: {
        action_type: "integration_test",
        actor_id: "ci-test-runner",
        environment: "staging",
      },
    });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);

    process.env.ATLASENT_API_KEY = saved;
  });
});
