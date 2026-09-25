// Usage: node test/reference-acceptance.mjs /absolute/reference-install/node_modules
// Installs are external to Gate. CI supplies @modelcontextprotocol/server-filesystem@2026.8.31.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const modules=resolve(process.argv[2]);
const {Client}=await import(pathToFileURL(join(modules,'@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(join(modules,'@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const root=mkdtempSync(join(tmpdir(),'atlasent-reference-'));
const dir=join(root,'files');
const {mkdirSync}=await import('node:fs');mkdirSync(dir);
const file=join(dir,'example.txt');
writeFileSync(file,'original');
const policy={version:1,default:'deny',rules:[
 {id:'read-example',tool:'read_text_file',kind:'read',effect:'allow',argumentsEquals:{path:file}},
 {id:'write-approved-content',tool:'write_file',kind:'write',effect:'allow',argumentsEquals:{path:file,content:'approved'}}
]};
writeFileSync(join(root,'policy.json'),JSON.stringify(policy));
const client=new Client({name:'atlasent-acceptance',version:'0.1.0'},{capabilities:{}});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'run',join(root,'policy.json'),join(root,'audit.jsonl'),'--',process.execPath,join(modules,'@modelcontextprotocol/server-filesystem/dist/index.js'),dir],stderr:'pipe'});
try {
 await client.connect(transport);
 const list=await client.listTools();assert.ok(list.tools.some(t=>t.name==='write_file'));
 assert.equal((await client.callTool({name:'read_text_file',arguments:{path:file}})).isError,undefined);
 const blocked=await client.callTool({name:'write_file',arguments:{path:file,content:'UNAPPROVED_SECRET'}});
 assert.equal(blocked.isError,true);assert.equal(readFileSync(file,'utf8'),'original');
 const allowed=await client.callTool({name:'write_file',arguments:{path:file,content:'approved'}});
 assert.notEqual(allowed.isError,true);assert.equal(readFileSync(file,'utf8'),'approved');
 const read=await client.callTool({name:'read_text_file',arguments:{path:file}});
 assert.ok(read.content.some(c=>c.text==='approved'));
 const unknown=await client.callTool({name:'create_directory',arguments:{path:join(dir,'blocked')}});
 assert.equal(unknown.isError,true);
 await client.close();
 const audit=readFileSync(join(root,'audit.jsonl'),'utf8');
 assert.ok(!audit.includes('UNAPPROVED_SECRET'));assert.ok(!audit.includes(file));
 console.log('PASS: official SDK client + filesystem server; blocked write leaves file unchanged; exact allowed write changes file; readback confirms; unknown tool blocked; payload/path omitted from audit.');
} finally {await client.close();rmSync(root,{recursive:true,force:true});}
