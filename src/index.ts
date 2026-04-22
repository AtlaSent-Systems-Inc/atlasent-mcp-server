#!/usr/bin/env node
/**
 * AtlaSent MCP server — CLI entry point.
 *
 * Wires the McpServer built in `server.ts` (the one with the
 * authorization-before-execution pattern) to a stdio transport so any
 * MCP-compatible host (Claude Desktop, Cursor, Claude Code, ...) can
 * consume it.
 *
 * Set `ATLASENT_TRANSPORT=http` to bind over HTTP instead — see
 * `http-transport.ts`.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { registerPolicyResources } from "./resources.js";
import { startHttpServer } from "./http-transport.js";
import { getMode } from "./engine.js";

async function main(): Promise<void> {
  const server = createServer();
  registerPolicyResources(server);

  if (process.env.ATLASENT_TRANSPORT === "http") {
    await startHttpServer(server);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_started",
      mode: getMode(),
      transport: process.env.ATLASENT_TRANSPORT === "http" ? "http" : "stdio",
    }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`atlasent-mcp-server failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
