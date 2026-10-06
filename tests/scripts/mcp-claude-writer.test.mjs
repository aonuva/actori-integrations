import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { switchConnections, rollbackConnection } from '../../scripts/lib/mcp-import.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'actori-native-test-'))
  const prior = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  t.after(async () => { for (const [k,v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'bin'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.PATH = `${join(dir,'bin')}:${prior.PATH}`
  // Stand-in for the external CLI, modeling its own unrelated session writes
  // and a failure after the Actori entry has already been installed.
  const command = join(dir,'bin','claude')
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const p = process.env.CLAUDE_CONFIG_DIR + '/.claude.json';
const args = process.argv.slice(2), op = args[1], name = args[5];
const c = JSON.parse(fs.readFileSync(p));
if (op === 'remove' && (c.failRemove === true || c.failRemove === name)) { console.error('private output'); process.exit(1) }
if (op === 'add-json') c.mcpServers[name] = JSON.parse(args[6]);
if (op === 'remove') delete c.mcpServers[name];
c.sessionWrites = (c.sessionWrites || 0) + 1;
fs.writeFileSync(p, JSON.stringify(c));
`)
  await chmod(command,0o700)
  const path = join(dir,'.claude.json'), backup = join(dir,'receipt.json')
  await writeFile(path,JSON.stringify({ mcpServers: { notion: { type:'http',url:'https://mcp.notion.com/mcp' }, unrelated: { command:'untouched' } } }))
  const read = async () => JSON.parse(await readFile(path,'utf8'))
  const edit = async fn => { const c = await read(); fn(c); await writeFile(path,JSON.stringify(c)) }
  return { path, backup, read, edit, client:'claude-code', names:['notion'], endpoint:'http://localhost:3020/mcp', authentication:'oauth', nativeClient:true }
}

test('native apply and rollback preserve unrelated client writes', async t => {
  const f = await fixture(t)
  assert.equal((await switchConnections(f)).configuration_writer,'claude')
  assert.equal((await f.read()).sessionWrites,undefined)
  await switchConnections({...f,apply:true})
  assert.deepEqual(Object.keys((await f.read()).mcpServers).sort(),['actori','unrelated'])
  await f.edit(c => { c.otherSessionState = 'keep' })
  await rollbackConnection(f.backup,true)
  const c = await f.read()
  assert.equal(c.otherSessionState,'keep');assert.equal(c.sessionWrites,4)
  assert.deepEqual(Object.keys(c.mcpServers).sort(),['notion','unrelated'])
  assert.equal((await rollbackConnection(f.backup,true)).already_original,true)
})

test('partial native failure leaves a recoverable receipt and withholds CLI output', async t => {
  const f = await fixture(t);f.names.push('docs');await f.edit(c=>{c.failRemove='docs';c.mcpServers.docs={type:'http',url:'https://learn.microsoft.com/api/mcp'}})
  await assert.rejects(switchConnections({...f,apply:true}),e=>e.message.includes('rollback receipt') && !e.message.includes('private output'))
  assert.ok((await f.read()).mcpServers.actori)
  assert.equal((await f.read()).mcpServers.notion,undefined)
  await f.edit(c=>{delete c.failRemove})
  await rollbackConnection(f.backup,true)
  assert.equal((await f.read()).mcpServers.actori,undefined)
  assert.ok((await f.read()).mcpServers.notion)
})

test('native rollback refuses changed selected entries', async t => {
  const f = await fixture(t);await switchConnections({...f,apply:true})
  await f.edit(c=>{c.mcpServers.actori.url='https://changed.example/mcp'})
  await assert.rejects(rollbackConnection(f.backup,true),/changed/)
  assert.equal((await f.read()).mcpServers.actori.url,'https://changed.example/mcp')
})

test('native preview rejects credential-bearing definitions and arbitrary files', async t => {
  const f = await fixture(t)
  await f.edit(c=>{c.mcpServers.notion.headers={Authorization:'Bearer secret'}})
  await assert.rejects(switchConnections(f),/URL-only/)
  const other = join(f.path,'..','custom.json')
  await f.edit(c=>{delete c.mcpServers.notion.headers})
  await writeFile(other,await readFile(f.path))
  await assert.rejects(switchConnections({...f,path:other}),/actual user config/)
  assert.equal((await f.read()).sessionWrites,undefined)
})
