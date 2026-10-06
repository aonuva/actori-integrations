import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditConnections } from '../../scripts/lib/mcp-discovery.mjs'
import { importDirectory } from '../../scripts/lib/mcp-import-storage.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'actori-audit-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, 'project'); await mkdir(project)
  return { home, project, client: 'claude-code', selected: [{ name: 'notion', endpoint: 'https://service.test/mcp' }], endpoint: 'https://actori.test/mcp' }
}
test('audit distinguishes active routes, plugins and other projects without credentials', async t => {
  const opts = await fixture(t)
  await writeFile(join(opts.home, '.claude.json'), JSON.stringify({ mcpServers: {
    alias: { type: 'http', url: 'https://service.test/mcp', headers: { Authorization: 'SECRET' } },
    local: { command: 'do-not-run' },
  }, projects: {
    [opts.project]: { mcpServers: { actori: { type: 'http', url: opts.endpoint } } },
    '/another/project': { mcpServers: { notion: { type: 'http', url: 'https://service.test/mcp' } } },
  } }))
  const plugin = join(opts.home, 'plugin.json')
  await writeFile(plugin, JSON.stringify({ notion: { type: 'http', url: 'https://different.test' } }))
  const report = await auditConnections({ ...opts, pluginConfigs: [plugin] })
  assert.equal(report.status, 'direct_routes_remaining')
  assert.equal(report.governance_verified, false)
  assert.deepEqual(report.remaining_routes.map(r => [r.name, r.assessment]), [
    ['alias', 'possible_bypass'], ['local', 'review_service_access'], ['notion', 'possible_bypass'],
  ])
  assert.equal(report.other_project_routes.length, 1)
  assert.equal(report.remaining_routes[2].plugin, true)
  assert.doesNotMatch(JSON.stringify(report), /SECRET|https:|do-not-run/)
})
test('no local bypass still requires cloud/live-client review, including unreadable sources', async t => {
  const opts = await fixture(t)
  await writeFile(join(opts.home, '.claude.json'), '{invalid')
  const report = await auditConnections(opts)
  assert.equal(report.status, 'client_review_required')
  assert.equal(report.governance_verified, false)
  assert.deepEqual(report.unreadable_sources, [join(opts.home, '.claude.json')])
})
test('durable storage creates unique private directories and refuses symlinks', async t => {
  const { home } = await fixture(t)
  const first = await importDirectory(home), second = await importDirectory(home)
  assert.notEqual(first, second)
  for (const path of [join(home, '.actori'), join(home, '.actori/imports'), first]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700)
  }
  await rm(join(home, '.actori'), { recursive: true })
  await symlink(join(home, 'project'), join(home, '.actori'))
  await assert.rejects(importDirectory(home), /real private directory/)
})
test('Cursor audit includes user and project routes', async t => {
  const opts = await fixture(t)
  for (const dir of [opts.home, opts.project]) {
    await mkdir(join(dir, '.cursor'))
    await writeFile(join(dir, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { notion: { url: 'https://service.test/mcp' } } }))
  }
  const report = await auditConnections({ ...opts, client: 'cursor' })
  assert.equal(report.remaining_routes.length, 2)
  assert.equal(report.status, 'direct_routes_remaining')
})
test('Claude discovery respects the configured client directory', async t => {
  const opts = await fixture(t)
  const original = process.env.CLAUDE_CONFIG_DIR
  t.after(() => { if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original })
  process.env.CLAUDE_CONFIG_DIR = opts.home
  await writeFile(join(opts.home, '.claude.json'), JSON.stringify({ mcpServers: { notion: { type: 'http', url: 'https://service.test/mcp' } } }))
  const report = await auditConnections({ ...opts, home: undefined })
  assert.equal(report.remaining_routes[0].path, join(opts.home, '.claude.json'))
  assert.equal(report.status, 'direct_routes_remaining')
})
