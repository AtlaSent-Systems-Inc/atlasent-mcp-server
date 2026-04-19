#!/usr/bin/env node
/**
 * Entry point for the AtlaSent MCP server.
 *
 * Transport selection:
 *   ATLASENT_TRANSPORT=http  → HTTP server (StreamableHTTP or SSE fallback)
 *   (unset / anything else)  → stdio (default MCP transport)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { registerPolicyResources } from "./resources.js";
import { startHttpServer } from "./http-transport.js";

async function main(): Promise<void> {
  const server = createServer();

  // Register the atlasent://policies/{policyId} resource template.
  registerPolicyResources(server);

  const transport = (process.env.ATLASENT_TRANSPORT ?? "").toLowerCase();

  if (transport === "http") {
    // HTTP transport — server.connect() is called inside startHttpServer.
    await startHttpServer(server);
    // Keep the process alive.
    await new Promise<void>(() => {/* intentionally never resolves */});
  } else {
    // Default: stdio transport.
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
