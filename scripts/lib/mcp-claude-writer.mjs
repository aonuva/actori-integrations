import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'

const execute = promisify(execFile)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Delegate shared-file writes to Claude, which owns ~/.claude.json. Never pass
// credentials to its command line or surface its raw stdout/stderr.
export async function claudeWriter(receipt) {
  if (receipt.client !== 'claude-code') throw new Error('Native configuration writes currently support Claude Code only.')
  const path = await realpath(receipt.path)
  const userFile = resolve(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
  let scope, cwd
  if (path === await realpath(userFile).catch(() => userFile)) {
    scope = receipt.project ? 'local' : 'user'
    cwd = receipt.project || process.cwd()
    if (receipt.project && await realpath(cwd) !== receipt.project) throw new Error('Use the canonical project path for native Claude configuration writes.')
  } else if (!receipt.project && path === resolve(dirname(path), '.mcp.json')) {
    scope = 'project'; cwd = dirname(path)
  } else throw new Error('Native Claude writes require its actual user config or a project .mcp.json; no custom file was changed.')
  if (Object.hasOwn(receipt.original, receipt.target)) throw new Error('Native switch requires a distinct Actori connection name.')
  for (const entry of [...Object.values(receipt.original), receipt.installed]) {
    if (entry.type !== 'http' || typeof entry.url !== 'string' || Object.keys(entry).some(k => !['type', 'url'].includes(k))) {
      throw new Error('Native switch supports URL-only HTTP definitions. For credential-bearing definitions use the stopped-client workflow.')
    }
    const url = new URL(entry.url)
    if (url.username || url.password || url.search || url.hash) throw new Error('Native switch cannot pass credential-bearing URLs to Claude.')
  }
  const run = async args => {
    try { await execute('claude', ['mcp', ...args], { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }) }
    catch { throw new Error('Claude MCP configuration command failed. Use the saved rollback receipt before retrying; command output withheld.') }
  }
  const read = async () => {
    const config = JSON.parse(await readFile(path, 'utf8'))
    return (receipt.project ? config.projects?.[receipt.project]?.mcpServers : config.mcpServers) || {}
  }
  const check = async () => {
    const servers = await read()
    if (Object.hasOwn(servers, receipt.target) && !same(servers[receipt.target], receipt.installed)) throw new Error('Actori connection changed; refusing to overwrite it.')
    for (const [name, entry] of Object.entries(receipt.original)) {
      if (Object.hasOwn(servers, name) && !same(servers[name], entry)) throw new Error('Selected connection changed; refusing to overwrite it.')
    }
    return servers
  }
  return {
    async apply() {
      const initial = await check()
      if (Object.hasOwn(initial, receipt.target) || Object.entries(receipt.original).some(([n,e]) => !same(initial[n],e))) throw new Error('Selected configuration changed before switch; nothing was changed by this attempt.')
      await run(['add-json', '--scope', scope, '--', receipt.target, JSON.stringify(receipt.installed)])
      for (const name of Object.keys(receipt.original)) {
        const servers = await check()
        if (!same(servers[receipt.target], receipt.installed)) throw new Error('Actori connection disappeared during switch; use the rollback receipt.')
        if (Object.hasOwn(servers, name)) await run(['remove', '--scope', scope, '--', name])
      }
      const servers = await check()
      if (!same(servers[receipt.target], receipt.installed) || Object.keys(receipt.original).some(n => Object.hasOwn(servers, n))) throw new Error('Claude configuration verification failed; use the rollback receipt.')
    },
    async rollback(apply) {
      let servers = await check()
      const restored = () => !Object.hasOwn(servers, receipt.target) && Object.entries(receipt.original).every(([n,e]) => same(servers[n],e))
      if (restored()) return { restored: true, already_original: true }
      if (apply) {
        for (const [name, entry] of Object.entries(receipt.original)) {
          servers = await check()
          if (!Object.hasOwn(servers, name)) await run(['add-json', '--scope', scope, '--', name, JSON.stringify(entry)])
        }
        servers = await check()
        if (Object.hasOwn(servers, receipt.target)) await run(['remove', '--scope', scope, '--', receipt.target])
        servers = await check()
        if (!restored()) throw new Error('Claude rollback verification failed; retain the receipt and inspect the selected scope.')
      }
      return { restored: apply, servers: Object.keys(receipt.original), project: receipt.project }
    },
  }
}
