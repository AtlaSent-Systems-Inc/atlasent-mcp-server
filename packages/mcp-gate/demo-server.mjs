// In-memory demonstration only: no external side effects.
import { createInterface } from 'node:readline';
let status = 'pending';
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!('id' in m)) continue;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'atlasent-demo', version: '0.1.0' } };
  else if (m.method === 'ping') result = {};
  else if (m.method === 'tools/list') result = { tools: [
    { name: 'read_status', description: 'Read demo status', inputSchema: { type: 'object', properties: {} } },
    { name: 'set_status', description: 'Set demo status', inputSchema: { type: 'object', properties: { environment: { type: 'string' }, status: { type: 'string' } }, required: ['environment','status'], additionalProperties: false } }
  ] };
  else if (m.method === 'tools/call') {
    if (m.params.name === 'set_status') status = m.params.arguments.status;
    result = { content: [{ type: 'text', text: status }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
}
