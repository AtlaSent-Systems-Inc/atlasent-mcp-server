/**
 * HTTP transport for the AtlaSent MCP server.
 *
 * When `ATLASENT_TRANSPORT=http` is set the server runs as an HTTP process
 * instead of using stdio. The implementation uses
 * `StreamableHTTPServerTransport` from the MCP SDK when available, with a
 * lightweight SSE-based fallback for older SDK versions.
 *
 * Endpoints (StreamableHTTP mode):
 *   POST /mcp          — send JSON-RPC messages
 *   GET  /mcp          — open SSE stream for server-to-client messages
 *   DELETE /mcp        — terminate a session
 *
 * Endpoints (SSE fallback mode):
 *   GET  /sse          — open SSE stream
 *   POST /message      — send JSON-RPC messages
 */

import http from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const PORT = Number(process.env.PORT ?? 3000);

// ---------------------------------------------------------------------------
// Attempt to use StreamableHTTPServerTransport (SDK >= 1.8)
// ---------------------------------------------------------------------------

async function tryStreamableTransport(server: McpServer): Promise<http.Server | null> {
  try {
    // Dynamic import so the module can load even when the export is absent.
    const sdkHttp = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js" as string
    ).catch(() => null);

    if (!sdkHttp || typeof sdkHttp.StreamableHTTPServerTransport !== "function") {
      return null;
    }

    const { StreamableHTTPServerTransport } = sdkHttp as {
      StreamableHTTPServerTransport: new (opts: { sessionIdGenerator: () => string }) => {
        handleRequest(
          req: http.IncomingMessage,
          res: http.ServerResponse,
          body?: unknown,
        ): Promise<void>;
        close(): Promise<void>;
      };
    };

    const { randomUUID } = await import("node:crypto");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport as unknown as Transport);

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      // Collect body for POST requests.
      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON");
          return;
        }
      }

      await transport.handleRequest(req, res, body);
    });

    return httpServer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE-based fallback transport
// ---------------------------------------------------------------------------

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

async function startSSETransport(server: McpServer): Promise<http.Server> {
  // One SSE transport per connection (stateful).
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // ---- GET /sse — open SSE stream ----------------------------------------
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      transports.set(transport.sessionId, transport);

      res.on("close", () => {
        transports.delete(transport.sessionId);
      });

      await server.connect(transport);
      return;
    }

    // ---- POST /message — receive JSON-RPC messages -------------------------
    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = transports.get(sessionId);

      if (!transport) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown sessionId" }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");

      // SSEServerTransport.handlePostMessage expects the raw Request body;
      // we reconstruct a minimal object the SDK accepts.
      const mockReq = Object.assign(req, { body: raw });
      await transport.handlePostMessage(mockReq as Parameters<typeof transport.handlePostMessage>[0], res);
      return;
    }

    // ---- Health check ------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: "sse" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return httpServer;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Start the MCP server over HTTP.
 *
 * Prefers `StreamableHTTPServerTransport` (SDK >= 1.8) and falls back to
 * the SSE-based transport for compatibility with older SDK versions.
 *
 * The server binds to `process.env.PORT` (default 3000).
 */
export async function startHttpServer(server: McpServer): Promise<void> {
  let httpServer = await tryStreamableTransport(server);
  let mode: string;

  if (httpServer) {
    mode = "streamable-http";
    // Health check is not built into StreamableHTTPServerTransport; wrap it.
    const originalHandler = (httpServer as http.Server).listeners("request")[0] as
      | http.RequestListener
      | undefined;
    httpServer.removeAllListeners("request");
    httpServer.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", transport: "streamable-http" }));
        return;
      }
      if (originalHandler) originalHandler(req, res);
    });
  } else {
    httpServer = await startSSETransport(server);
    mode = "sse";
  }

  await new Promise<void>((resolve, reject) => {
    httpServer!.listen(PORT, () => {
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "http_transport_started",
          mode,
          port: PORT,
        }) + "\n",
      );
      resolve();
    });
    httpServer!.once("error", reject);
  });
}
