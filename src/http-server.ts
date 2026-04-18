import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

type RpcHandler = (body: unknown) => Promise<unknown>;

export function startHttpServer(handleRpc: RpcHandler): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Send POST requests to /mcp' }));
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        const result = await handleRpc(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } }));
      }
    });
  });
  server.listen(PORT, () => {
    process.stderr.write(`AtlaSent MCP HTTP server listening on http://localhost:${PORT}/mcp\n`);
  });
}
