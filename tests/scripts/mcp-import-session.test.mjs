import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startImport, importStatus, finishImport, launchClient } from '../../scripts/lib/mcp-import-session.mjs'
import { rollbackConnection } from '../../scripts/lib/mcp-import.mjs'
import { discoverConnections } from '../../scripts/lib/mcp-discovery.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'actori-session-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'client.json'), session = join(dir, 'session.json'), backup = join(dir, 'backup.json')
  await writeFile(path, JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer provider-secret' } } } }))
  return { dir, path, session, backup, client: 'cursor', names: ['docs'], ui: 'http://localhost:3021' }
}

test('pairing, selected manifest upload, verified cutover, launch and rollback', async t => {
  const args = await fixture(t)
  const started = await startImport(args)
  const diagnosticState = JSON.parse(await readFile(args.session, 'utf8')); diagnosticState.authentication = 'bearer'
  await writeFile(args.session, JSON.stringify(diagnosticState))
  assert.equal(JSON.stringify(started).includes('provider-secret'), false)
  assert.equal((await stat(args.session)).mode & 0o777, 0o600)
  assert.equal((await readFile(args.session, 'utf8')).includes('provider-secret'), false)
  let paired = false, manifest = null, status = 'configuring', issued = 0
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url, body: opts.body })
    const payload = opts.body ? JSON.parse(opts.body) : undefined
    const reply = data => Response.json(data)
    if (url.endsWith('/exchange')) { paired = true; return reply({ exchanged: true }) }
    if (url.endsWith('/credential')) { issued++; return reply({ token: 'agent-secret', expires_at: new Date(Date.now() + 60000).toISOString(), endpoint: 'http://localhost:3020/mcp' }) }
    if (url.endsWith('/mcp')) {
      assert.equal(opts.headers.Authorization, 'Bearer agent-secret')
      return reply({ result: payload.method === 'tools/list' ? { tools: [{ name: 'docs-search' }] } : { capabilities: {} } })
    }
    if (!paired) return Response.json({}, { status: 401 })
    if (opts.method === 'PUT') { manifest = payload; return reply({}) }
    return reply({ status, manifest, agent_id: 'agent', progress: { docs: { actions: [{ name: 'docs-search' }] } } })
  })
  await importStatus(args.session)
  assert.equal(manifest.connections.length, 1)
  assert.equal(JSON.stringify(requests).includes('provider-secret'), false)
  status = 'ready'
  const original = await readFile(args.path, 'utf8')
  assert.equal((await finishImport({ session: args.session })).applied, false)
  assert.equal(await readFile(args.path, 'utf8'), original)
  await finishImport({ session: args.session, backup: args.backup, apply: true })
  assert.equal(issued, 1)
  assert.equal((await finishImport({ session: args.session })).already_applied, true)
  assert.equal((await launchClient(args.session, [process.execPath, '-e', 'process.exit(process.env.ACTORI_AGENT_TOKEN === "agent-secret" ? 7 : 9)'])).exit_code, 7)
  assert.equal((await readFile(args.path, 'utf8')).includes('agent-secret'), false)
  await rollbackConnection(args.backup, true)
  await assert.rejects(launchClient(args.session, [process.execPath]), /restored or changed/)
  await assert.rejects(finishImport({ session: args.session }), /restored or changed/)
})

test('a selected configuration edit blocks credential issuance and cutover', async t => {
  const args = await fixture(t)
  await startImport(args)
  await writeFile(args.path, JSON.stringify({ mcpServers: { docs: { url: 'https://changed.example/mcp' } } }))
  let credentials = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/credential')) credentials++
    return Response.json({ status: 'ready', manifest: {}, progress: {} })
  })
  await assert.rejects(finishImport({ session: args.session, apply: true, backup: args.backup }), /changed after discovery/)
  assert.equal(credentials, 0)
  await assert.rejects(stat(args.backup), { code: 'ENOENT' })
})

test('discovery reports overrides and explicit plugin definitions without exporting credentials', async t => {
  const { dir } = await fixture(t)
  await mkdir(join(dir, '.cursor'))
  await mkdir(join(dir, 'project', '.cursor'), { recursive: true })
  await writeFile(join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer secret' } } } }))
  await writeFile(join(dir, 'project', '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'must-never-execute' } } }))
  const plugin = join(dir, 'plugin.mcp.json')
  await writeFile(plugin, JSON.stringify({ docs: { url: 'https://plugin.example/mcp' } }))
  const result = await discoverConnections({ client: 'cursor', home: dir, project: join(dir, 'project'), pluginConfigs: [plugin] })
  assert.equal(result.conflicts[0].locations.length, 3)
  assert.equal(result.sources[2].plugin, true)
  assert.equal(result.sources[1].connections[0].status, 'unsupported')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('must-never-execute'), false)
})

for (const client of ['claude-code', 'cursor']) test(`${client}: native OAuth cutover stores no agent token and restores original routing`, async t => {
  const args = await fixture(t)
  args.client = client
  await writeFile(args.path, JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }))
  await startImport(args)
  const original = await readFile(args.path, 'utf8')
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    url = String(url)
    if (url.endsWith('/credential')) {
      assert.equal(JSON.parse(opts.body).authentication, 'oauth')
      return Response.json({ authentication: 'oauth', token: 'temporary-verification-token', endpoint: 'http://localhost:3020/mcp', issuer: 'https://identity.example' })
    }
    if (url.includes('/.well-known/')) return Response.json({ resource: 'http://localhost:3020/mcp', authorization_servers: ['https://identity.example'] })
    if (url.endsWith('/mcp')) return Response.json({ result: JSON.parse(opts.body).method === 'tools/list' ? { tools: [{ name: 'docs-search' }] } : {} })
    return Response.json({ status: 'ready', manifest: {}, progress: { docs: { actions: [{ name: 'docs-search' }] } } })
  })
  const preview = await finishImport({ session: args.session })
  assert.equal(preview.authentication, 'oauth')
  assert.equal(preview.client_authorization, 'pending_native_sign_in')
  assert.equal(await readFile(args.path, 'utf8'), original)
  await finishImport({ session: args.session, apply: true, backup: args.backup })
  const installed = JSON.parse(await readFile(args.path, 'utf8')).mcpServers.actori
  assert.deepEqual(installed, client === 'cursor' ? { url: 'http://localhost:3020/mcp' } : { type: 'http', url: 'http://localhost:3020/mcp' })
  for (const path of [args.path, args.session, args.backup]) assert.equal((await readFile(path, 'utf8')).includes('temporary-verification-token'), false)
  assert.equal((await finishImport({ session: args.session })).already_applied, true)
  await assert.rejects(finishImport({ session: args.session, authentication: 'bearer' }), /Restore the original/)
  await rollbackConnection(args.backup, true)
  assert.deepEqual(JSON.parse(await readFile(args.path, 'utf8')), JSON.parse(original))
})

test('OAuth setup failure never falls back to a bearer config or changes direct routes', async t => {
  const args = await fixture(t)
  await startImport(args)
  const original = await readFile(args.path, 'utf8')
  for (const scenario of ['unconfigured', 'metadata-mismatch']) {
    t.mock.method(globalThis, 'fetch', async url => {
      url = String(url)
      if (url.endsWith('/credential')) return scenario === 'unconfigured'
        ? Response.json({ error: 'Enable client sign-in first.' }, { status: 409 })
        : Response.json({ authentication: 'oauth', token: 'temporary', endpoint: 'http://localhost:3020/mcp', issuer: 'https://identity.example' })
      if (url.includes('/.well-known/')) return Response.json({ resource: 'https://other.example/mcp', authorization_servers: ['https://identity.example'] })
      return Response.json({ status: 'ready', manifest: {}, progress: {} })
    })
    await assert.rejects(finishImport({ session: args.session, apply: true, backup: args.backup }), /sign-in|discovery/)
    assert.equal(await readFile(args.path, 'utf8'), original)
    await assert.rejects(stat(args.backup), { code: 'ENOENT' })
  }
})
