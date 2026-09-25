import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { decide, runGate } from '../gate.mjs';

const policy = { version: 1, default: 'deny', rules: [
  { id: 'read', tool: 'read_status', effect: 'allow', kind: 'read', argumentsEquals: {} },
  { id: 'write', tool: 'set_status', effect: 'allow', kind: 'write', argumentsEquals: { environment: 'sandbox', status: 'ready' } },
] };
const meta = { progressToken: 'PRIVATE_METADATA', 'client.example/context': { approved: true } };

test('MCP metadata does not replace exact arguments or defeat default and explicit denials', () => {
  const read = { name: 'read_status', arguments: {}, _meta: meta };
  assert.equal(decide(policy, read).effect, 'allow');
  assert.equal(decide(policy, { name: 'read_status', _meta: {} }).effect, 'allow');
  assert.equal(decide({ ...policy, rules: [] }, read).reason, 'no_matching_rule');
  assert.equal(decide({ ...policy, rules: [...policy.rules, { id: 'stop', tool: 'read_status', kind: 'read', effect: 'deny' }] }, read).reason, 'stop');
  assert.equal(decide(policy, { name: 'set_status', arguments: { environment: 'sandbox', status: 'ready' }, _meta: meta }).effect, 'allow');
  for (const argumentsValue of [{ environment: 'production', status: 'ready' }, { environment: 'sandbox', status: 'ready', extra: true }]) {
    assert.equal(decide(policy, { name: 'set_status', arguments: argumentsValue, _meta: meta }).reason, 'no_matching_rule');
  }
  for (const bad of [null, [], 'text', 12, true]) {
    assert.equal(decide(policy, { ...read, _meta: bad }).reason, 'invalid_arguments');
    assert.equal(decide(policy, { ...read, arguments: bad }).reason, 'invalid_arguments');
  }
  assert.equal(decide(policy, { ...read, unexpected: true }).reason, 'invalid_arguments');
});

test('real stdio boundary strips metadata before cloud authorization, forwarding and audit', { timeout: 10000 }, async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output });
  const iterator = lines[Symbol.asyncIterator]();
  const audit = [], authorized = [];
  const upstream = "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params})+'\\n');});";
  const running = runGate({ policy, input, output, command: process.execPath, args: ['-e', upstream],
    audit: event => audit.push(event),
    authorize: async params => { authorized.push(params); return { effect: 'allow', reason: 'test_authorized' }; },
  });
  try {
    for (const [id, params] of [
      [1, { name: 'read_status', arguments: {}, _meta: meta }],
      [2, { name: 'set_status', arguments: { environment: 'sandbox', status: 'ready' }, _meta: meta }],
    ]) {
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) + '\n');
      const result = JSON.parse((await iterator.next()).value).result;
      const expected = { name: params.name, arguments: params.arguments };
      assert.deepEqual(result, expected);
      assert.deepEqual(authorized.at(-1), expected);
    }
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'set_status', arguments: { environment: 'production', status: 'ready' }, _meta: meta } }) + '\n');
    const blocked = JSON.parse((await iterator.next()).value).result;
    assert.match(blocked.content[0].text, /no_matching_rule/);
    assert.equal(authorized.length, 2);
    assert.equal(audit.filter(event => event.status === 'server_returned').length, 2);
    assert.ok(!JSON.stringify(audit).includes('PRIVATE_METADATA'));
  } finally {
    input.end();
    await running;
    lines.close();
    output.destroy();
  }
});
