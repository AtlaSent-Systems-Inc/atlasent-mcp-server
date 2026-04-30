#!/usr/bin/env node
/**
 * CLI entry for `@atlasent/mcp-server`.
 *
 * Per CLAUDE.md, this file:
 *   1. creates the server (`createServer()` from `server.ts`)
 *   2. registers the policy resource template
 *   3. connects a transport — stdio by default, HTTP if ATLASENT_TRANSPORT=http
 *
 * Tool handlers, decision logic, and wire contract live in their own files.
 * This is the harness that wires them together.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { registerPolicyResources } from "./resources.js";
import { startHttpServer } from "./http-transport.js";

function log(event: string, data: Record<string, unknown> = {}): void {
  // stderr only — stdout is reserved for MCP stdio framing.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    pkg: "@atlasent/mcp-server",
    ...data,
  });
  process.stderr.write(line + "\n");
}

async function main(): Promise<void> {
  const server = createServer();
  registerPolicyResources(server);

  const transport = (process.env.ATLASENT_TRANSPORT ?? "stdio").toLowerCase();

  if (transport === "http" || transport === "sse" || transport === "streamable-http") {
    await startHttpServer(server);
    log("server_started", { transport });
    return;
  }

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  log("server_started", { transport: "stdio" });
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_fatal",
      pkg: "@atlasent/mcp-server",
      error: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
});
