// Real runtime acceptance using only the bundled in-memory MCP server.
// Does not seed organizations, alter policies, or approve its own request.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { validateConnection } from '../cloud.mjs';

const [connectionPath, outputDirectory] = process.argv.slice(2);
let child;
try {
  if (!connectionPath || !outputDirectory || process.argv.length !== 4) throw Error('usage');
  const connection = validateConnection(JSON.parse(readFileSync(connectionPath, 'utf8')));
  if (connection.environment !== 'sandbox' || !process.env.ATLASENT_GATE_API_KEY?.startsWith('ask_test_')) throw Error('sandbox key required');
  if (!connection.tools.read_status || !connection.tools.set_status) throw Error('map both demo tools');
  if (['kttccumlnmdtupgbyfue.supabase.co', 'ihghhasvxtltlbizvkqy.supabase.co'].includes(new URL(connection.apiUrl).hostname)) throw Error('production destination');
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { mode: 0o700 }); // New output directory only.
  mkdirSync(join(directory, 'activity'), { mode: 0o700 });
  const policy = { version: 1, default: 'deny', rules: [
    { id: 'read', tool: 'read_status', effect: 'allow', kind: 'read', argumentsEquals: {} },
    { id: 'write', tool: 'set_status', effect: 'allow', kind: 'write', argumentsEquals: { environment: 'sandbox', status: 'ready' } },
  ] };
  writeFileSync(join(directory, 'policy.json'), JSON.stringify(policy), { mode: 0o600, flag: 'wx' });
  const pkg = fileURLToPath(new URL('../', import.meta.url));
  child = spawn(process.execPath, [join(pkg, 'cli.mjs'), 'run-connected', join(directory, 'policy.json'),
    resolve(connectionPath), join(directory, 'activity'), '--', process.execPath, join(pkg, 'demo-server.mjs')],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  let nextId = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  child.on('error', () => { for (const callback of pending.values()) callback({ error: { code: -32603 } }); pending.clear(); });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { child.kill(); return; }
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback(message); }
  });
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(Error('timeout')); }, 155000);
      const exited = () => { clearTimeout(timeout); pending.delete(id); reject(Error('gate exited')); };
      child.once('exit', exited);
      pending.set(id, message => { clearTimeout(timeout); child.removeListener('exit', exited); resolveResult(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const text = response => response.result?.content?.[0]?.text;
  const call = (name, args) => request('tools/call', { name, arguments: args });
  const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'atlasent-live-acceptance', version: '1' } });
  if (initialized.error) throw Error('initialize failed');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  if (text(await call('read_status', {})) !== 'pending') throw Error('initial read failed');
  const blocked = await call('set_status', { environment: 'production', status: 'ready' });
  if (!blocked.error && blocked.result?.isError !== true) throw Error('local deny failed');
  if (text(await call('read_status', {})) !== 'pending') throw Error('blocked call changed state');
  process.stderr.write('Calling sandbox set_status. If held, the authorized reviewer must resolve it in the sandbox console.\n');
  if (text(await call('set_status', { environment: 'sandbox', status: 'ready' })) !== 'ready') throw Error('runtime did not authorize the call');
  if (text(await call('read_status', {})) !== 'ready') throw Error('readback failed');
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ status: 'passed', recordedAt: new Date().toISOString(),
    checks: ['live runtime allowed demo reads', 'local deny prevented state change', 'live authorization preceded write', 'demo readback matched'],
    limitations: ['Does not prove external effects, runtime-deny policies, tenant isolation or approval unless separately inspected in audit.'] }, null, 2), { mode: 0o600, flag: 'wx' });
  child.stdin.end();
  process.stdout.write('PASS: live sandbox demo. Inspect result.json and activity; this is not full release acceptance.\n');
} catch {
  process.stderr.write('FAIL: live sandbox acceptance incomplete. Requires a sandbox connection mapping read_status and set_status, an ask_test_ key, and a new output directory. Inspect the private activity report for the sanitized decision reason.\n');
  process.exitCode = 1;
} finally {
  if (child) { child.stdin.end(); child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref(); }
}
