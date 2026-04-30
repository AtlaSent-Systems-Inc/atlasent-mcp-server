#!/usr/bin/env node
/**
 * CLI entry point — connects the MCP server to a stdio transport.
 *
 * The server is constructed by createServer() in ./server.ts; this file
 * wires it to a transport and starts listening.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_started",
      transport: "stdio",
    }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_failed",
      error: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
});
