import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConnection } from './cloud.mjs';

// Generate a separate snippet; never overwrite a client's existing configuration.
export function setup(directory, command, args = [], connection) {
  if (connection) validateConnection(connection);
  const executable = command === 'node' ? process.execPath : command;
  if (!isAbsolute(executable) || !statSync(executable).isFile()) throw Error('Use an absolute executable path');
  const dir = resolve(directory);
  mkdirSync(dir, { mode: 0o700 }); // Existing directories intentionally fail.
  mkdirSync(join(dir, 'activity'), { mode: 0o700 });
  const policy = join(dir, 'policy.json');
  writeFileSync(policy, JSON.stringify({ version: 1, default: 'deny', rules: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (connection) writeFileSync(join(dir, 'connection.json'), JSON.stringify(connection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const config = { mcpServers: { 'atlasent-gate': {
    command: process.execPath,
    args: [fileURLToPath(new URL('cli.mjs', import.meta.url)), ...(connection ? ['run-connected', policy, join(dir, 'connection.json')] : ['run-dir', policy]), join(dir, 'activity'), '--', executable, ...args]
  } } };
  writeFileSync(join(dir, 'mcp-client.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, 'START-HERE.txt'), '1. Review policy.json; all tool calls start blocked.\n2. Copy the atlasent-gate entry from mcp-client.json into your MCP client configuration.\n3. Use absolute paths in upstream arguments; the client may run from a different directory.\n4. Restart the client after reviewing rules. Each launch creates a new private activity log.\n5. Run: node <gate>/cli.mjs report <activity-log> <new-report.html>\nNo account required. Local policy is not organizational authorization.\n', { flag:'wx', mode:0o600 });
  if (connection) writeFileSync(join(dir, 'CONNECTED-MODE.txt'), 'Supply ATLASENT_GATE_API_KEY to the Gate process via your client secret configuration. Do not put the key in policy.json or connection.json. Every locally allowed call now also requires cloud evaluate and consumed permit verification. Hold/deny/errors block; no local fallback. This is a manual organization-key connection, not enrollment. Raw arguments stay local; mapped target/action/actor/environment and a digest are sent to the configured HTTPS endpoint. Review that destination before use.\n', { flag: 'wx', mode: 0o600 });
  return dir;
}
