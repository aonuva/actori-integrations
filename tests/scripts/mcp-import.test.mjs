import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseConfig, replacement, scanFile, rollbackConnection } from '../../scripts/lib/mcp-import.mjs'

const notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }
const endpoint = 'http://localhost:3010/mcp'

async function fixture(t, config = { mcpServers: { notion, other: { command: 'do-not-run', env: { SECRET: 'hidden' } } } }) {
  const dir = await mkdtemp(join(tmpdir(), 'actori-import-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'config.json')
  const backup = join(dir, 'receipt.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  return { path, backup, name: 'notion', endpoint, tokenEnv: 'ACTORI_AGENT_TOKEN' }
}

test('inventory identifies user and project scopes without exporting secrets', () => {
  const result = connectionInventory({ mcpServers: { notion, remote: { url: 'https://host/secret?key=hidden', headers: { Authorization: 'hidden' } } },
    projects: { '/work/project': { mcpServers: { local: { command: 'hidden', args: ['hidden'], env: { TOKEN: 'hidden' } }, notion } } } })
  assert.equal(result.connections.length, 4)
  assert.equal(result.connections[0].status, 'setup_required')
  assert.equal(result.connections[3].project, '/work/project')
  assert.equal(JSON.stringify(result).includes('hidden'), false)
  assert.equal(JSON.stringify(result).includes('https://host'), false)
})

test('invalid JSON cannot leak the offending secret in an error', () => {
  assert.throws(() => parseConfig('{"token":"sensitive" invalid}'), error => !error.message.includes('sensitive'))
})

test('replacement contains a Claude environment reference, never its value', () => {
  assert.equal(replacement(endpoint, 'ACTORI_AGENT_TOKEN').headers.Authorization, 'Bearer ${ACTORI_AGENT_TOKEN}')
  for (const url of ['http://remote/mcp', 'https://user:secret@host/mcp', 'https://host/mcp?key=x', 'https://host/other', 'file:///mcp']) {
    assert.throws(() => replacement(url, 'ACTORI_AGENT_TOKEN'))
  }
  assert.throws(() => replacement(endpoint, 'secret-token'))
})

test('scan and switch preview leave configuration byte-for-byte unchanged', async t => {
  const args = await fixture(t)
  const before = await readFile(args.path, 'utf8')
  assert.equal((await scanFile(args.path)).connections.length, 2)
  assert.equal((await switchConnection(args)).applied, false)
  assert.equal(await readFile(args.path, 'utf8'), before)
  await assert.rejects(stat(args.backup), { code: 'ENOENT' })
})

test('switch and rollback preserve unrelated changes and protect the receipt', async t => {
  const args = await fixture(t)
  await switchConnection({ ...args, apply: true })
  assert.equal((await stat(args.backup)).mode & 0o777, 0o600)
  assert.equal((await readFile(args.backup, 'utf8')).includes('hidden'), false)
  const installed = parseConfig(await readFile(args.path, 'utf8'))
  assert.deepEqual(installed.mcpServers.notion, replacement(endpoint, args.tokenEnv))
  installed.mcpServers.other.args = ['later-change']
  await writeFile(args.path, JSON.stringify(installed))
  assert.equal((await rollbackConnection(args.backup)).restored, false)
  await rollbackConnection(args.backup, true)
  const restored = parseConfig(await readFile(args.path, 'utf8'))
  assert.deepEqual(restored.mcpServers.notion, notion)
  assert.deepEqual(restored.mcpServers.other.args, ['later-change'])
  assert.equal((await rollbackConnection(args.backup, true)).already_original, true)
})

test('project switch touches only the selected scope', async t => {
  const args = await fixture(t, { mcpServers: { notion }, projects: { '/one': { mcpServers: { notion } }, '/two': { mcpServers: { notion } } } })
  await switchConnection({ ...args, project: '/one', apply: true })
  const config = parseConfig(await readFile(args.path, 'utf8'))
  assert.deepEqual(config.mcpServers.notion, notion)
  assert.deepEqual(config.projects['/two'].mcpServers.notion, notion)
  assert.equal(config.projects['/one'].mcpServers.notion.url, endpoint)
  await rollbackConnection(args.backup, true)
  assert.deepEqual(parseConfig(await readFile(args.path, 'utf8')).projects['/one'].mcpServers.notion, notion)
})

test('rollback refuses to overwrite a connection edited after switching', async t => {
  const args = await fixture(t)
  await switchConnection({ ...args, apply: true })
  const config = parseConfig(await readFile(args.path, 'utf8'))
  config.mcpServers.notion.url = 'https://different.example/mcp'
  await writeFile(args.path, JSON.stringify(config))
  await assert.rejects(rollbackConnection(args.backup, true), /changed since switching/)
})

test('existing backup or a missing server never mutates the configuration', async t => {
  const args = await fixture(t)
  const before = await readFile(args.path, 'utf8')
  await writeFile(args.backup, 'keep me')
  await assert.rejects(switchConnection({ ...args, apply: true }), { code: 'EEXIST' })
  await assert.rejects(switchConnection({ ...args, name: 'missing', apply: true }), /missing or unsupported/)
  assert.equal(await readFile(args.path, 'utf8'), before)
  assert.equal(await readFile(args.backup, 'utf8'), 'keep me')
})

test('configuration symlinks are refused', async t => {
  const args = await fixture(t)
  const linked = `${args.path}.link`
  await symlink(args.path, linked)
  await assert.rejects(scanFile(linked), /regular configuration/)
})

test('CLI scan works without connecting to any server or executing a command', async t => {
  const args = await fixture(t)
  const output = execFileSync(process.execPath, ['scripts/mcp-import.mjs', 'scan', '--config', args.path], { encoding: 'utf8' })
  assert.equal(JSON.parse(output).connections[0].provider, 'notion-mcp')
  assert.equal(output.includes('hidden'), false)
})

import { clientAdapter, remoteConnection, connectionInventory } from '../../scripts/lib/mcp-client-config.mjs'
import { switchConnections } from '../../scripts/lib/mcp-import.mjs'
const switchConnection = args => switchConnections({ ...args, names: [args.name], target: args.name })
const docs = { type: 'http', url: 'https://learn.microsoft.com/api/mcp' }

test('client adapters use distinct credential syntax and config scope', () => {
  assert.equal(clientAdapter('cursor').connection(endpoint, 'TOKEN').headers.Authorization, 'Bearer ${env:TOKEN}')
  assert.equal(clientAdapter('claude-code').connection(endpoint, 'TOKEN').headers.Authorization, 'Bearer ${TOKEN}')
  assert.throws(() => clientAdapter('cursor').servers({}, '/project'))
  assert.deepEqual(clientAdapter('cursor').paths('/project', '/home'), ['/home/.cursor/mcp.json', '/project/.cursor/mcp.json'])
})

test('generic discovery supports remote URLs without exporting endpoints or credentials', () => {
  const config = { mcpServers: { docs, authenticated: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private-value' } }, missing: { url: docs.url, headers: { Authorization: 'Bearer ${env:ABSENT}' } } } }
  const scan = connectionInventory(config, 'cursor', {})
  assert.equal(scan.connections[0].provider, 'custom-mcp')
  assert.equal(scan.connections[1].auth, 'bearer')
  assert.equal(scan.connections[2].credentialAvailable, false)
  assert.ok(!JSON.stringify(scan).includes('private-value'))
  assert.ok(!JSON.stringify(scan).includes(docs.url))
  for (const bad of [{ ...docs, headers: { 'X-Key': 'private-value' } }, { ...docs, url: 'https://host/mcp?secret=value' }, { ...docs, type: 'sse' }, { command: 'malicious' }]) {
    assert.equal(remoteConnection(bad).status, 'unsupported')
  }
})

for (const client of ['claude-code', 'cursor']) test(`${client}: consolidate two connections and restore while preserving unrelated edits`, async t => {
  const args = await fixture(t, { mcpServers: { notion, docs, unrelated: { command: 'keep' } } })
  const options = { ...args, client, names: ['notion', 'docs'] }
  assert.equal((await switchConnections(options)).applied, false)
  await switchConnections({ ...options, apply: true })
  let config = parseConfig(await readFile(args.path, 'utf8'))
  assert.deepEqual(Object.keys(config.mcpServers), ['unrelated', 'actori'])
  assert.deepEqual(config.mcpServers.actori, clientAdapter(client).connection(endpoint, args.tokenEnv))
  config.mcpServers.unrelated.args = ['new']
  await writeFile(args.path, JSON.stringify(config))
  await rollbackConnection(args.backup, true)
  config = parseConfig(await readFile(args.path, 'utf8'))
  assert.deepEqual(config.mcpServers.notion, notion)
  assert.deepEqual(config.mcpServers.docs, docs)
  assert.deepEqual(config.mcpServers.unrelated.args, ['new'])
  assert.equal(config.mcpServers.actori, undefined)
  assert.equal((await rollbackConnection(args.backup, true)).already_original, true)
})

test('group switch refuses name collisions; rollback refuses recreated direct entries', async t => {
  const args = await fixture(t, { mcpServers: { notion, docs } })
  await assert.rejects(switchConnections({ ...args, names: ['notion'], target: 'docs', apply: true }), /already in use/)
  await switchConnections({ ...args, names: ['notion', 'docs'], apply: true })
  const config = parseConfig(await readFile(args.path, 'utf8'))
  config.mcpServers.docs = { url: 'https://other.example/mcp' }
  await writeFile(args.path, JSON.stringify(config))
  await assert.rejects(rollbackConnection(args.backup, true), /changed since switching/)
})

test('Claude remote entries require explicit transport while Cursor can infer HTTP', () => {
  assert.equal(remoteConnection({ url: docs.url }, 'claude-code').status, 'unsupported')
  assert.equal(remoteConnection({ url: docs.url }, 'cursor').status, 'setup_required')
})

test('existing bootstrap connection survives cutover and rollback', async t => {
  const f = await fixture(t, { mcpServers: { notion, actori: { type: 'http', url: endpoint } } })
  await switchConnections({ ...f, names: ['notion'], authentication: 'oauth', apply: true })
  await rollbackConnection(f.backup, true)
  const servers = JSON.parse(await readFile(f.path, 'utf8')).mcpServers
  assert.deepEqual(servers, { actori: { type: 'http', url: endpoint }, notion })
  assert.equal((await rollbackConnection(f.backup, true)).already_original, true)
})

test('selected connector plan omits credentials and unrelated definitions', async t => {
  const f = await fixture(t, { mcpServers: { selected: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private-token' } }, other: notion } })
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/mcp-import.mjs', 'plan', '--client', 'claude-code', '--config', f.path, '--server', 'selected'], { encoding: 'utf8' }))
  assert.deepEqual(result.connections, [{ name: 'selected', endpoint: 'https://example.test/mcp', auth: 'bearer' }])
  assert.doesNotMatch(JSON.stringify(result), /private-token|notion/)
})
