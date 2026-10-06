import { claudeWriter } from './mcp-claude-writer.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clientAdapter, remoteConnection, connectionInventory } from './mcp-client-config.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function parseConfig(text) {
  let config
  try { config = JSON.parse(text) } catch { throw new Error('Invalid JSON configuration (contents withheld).') }
  if (!object(config)) throw new Error('Configuration must be a JSON object.')
  return config
}

export function actorEndpoint(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid Actori endpoint.') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('Use an HTTPS Actori /mcp URL without credentials or query parameters (HTTP is allowed on loopback).')
  }
  return url.href
}

export function replacement(endpoint, tokenEnv) {
  if (typeof tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(tokenEnv)) {
    throw new Error('Provide an environment variable name, not a token.')
  }
  return { type: 'http', url: actorEndpoint(endpoint), headers: { Authorization: `Bearer \${${tokenEnv}}` } }
}

async function readConfigFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Use a regular configuration file with no symbolic or hard links.')
  }
  if (stat.size > 5 * 1024 * 1024) throw new Error('Configuration exceeds the 5 MiB limit.')
  const text = await readFile(path, 'utf8')
  return { text, config: parseConfig(text), mode: stat.mode & 0o777 }
}

export async function scanFile(path, client = 'claude-code') {
  const { config } = await readConfigFile(path)
  return connectionInventory(config, client)
}

async function replaceFile(path, before, config, mode) {
  const temporary = `${path}.actori-${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: mode & 0o600, flag: 'wx' })
    const latest = await readConfigFile(path)
    if (latest.text !== before) throw new Error('Configuration changed during the operation; nothing was replaced.')
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function rollbackConnection(backup, apply = false) {
  const receipt = parseConfig((await readConfigFile(backup)).text)
  if (receipt.version !== 2) throw new Error('Unsupported rollback receipt version.')
  return rollbackGroup(receipt, apply)
}

// Version 2 switches several services in ONE file/scope to one Actori entry.
// Separate files have separate receipts; partial progress is recoverable.
export async function switchConnections({ path, names, project = null, client = 'claude-code', target = 'actori', endpoint, tokenEnv, authentication = 'bearer', backup, apply = false, nativeClient = false }) {
  const adapter = clientAdapter(client)
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n) || new Set(names).size !== names.length) throw new Error('Select distinct server names.')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(target)) throw new Error('Choose a simple Actori connection name.')
  path = resolve(path)
  const { text, config, mode } = await readConfigFile(path)
  const servers = adapter.servers(config, project)
  if (!object(servers)) throw new Error('Configuration scope not found.')
  if (own(servers, target) && !names.includes(target)) throw new Error('The Actori connection name is already in use; choose another name.')
  const original = Object.fromEntries(names.map(name => {
    if (!own(servers, name) || remoteConnection(servers[name], client).status === 'unsupported') throw new Error('Selected connection is missing or unsupported; scan again.')
    return [name, servers[name]]
  }))
  if (!['oauth', 'bearer'].includes(authentication)) throw new Error('Choose oauth or bearer authentication.')
  if (authentication === 'bearer') replacement(endpoint, tokenEnv)
  const installed = adapter.connection(actorEndpoint(endpoint), tokenEnv, authentication)
  const plan = { client, project, servers: names, target, endpoint: installed.url, authentication, ...(authentication === 'bearer' ? { token_env: tokenEnv } : {}), applied: false,
    warnings: ['Restart the client after switching. Other scopes and plugin/cloud routes may remain direct.', 'Verify Actori discovery and permissions before applying; this command only changes configuration.'] }
  const receipt = { version: 2, path, client, project, target, original, installed, digest: digest(installed), ...(nativeClient ? { writer: 'claude' } : {}) }
  const writer = nativeClient ? await claudeWriter(receipt) : null
  if (writer) plan.configuration_writer = 'claude'
  if (!apply) return plan
  if (!backup || resolve(backup) === path) throw new Error('Provide a new rollback receipt outside the configuration file.')
  await writeFile(backup, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  if (writer) {
    await writer.apply()
    return { ...plan, applied: true, backup: resolve(backup) }
  }
  for (const name of names) delete servers[name]
  // Define the property to avoid special-name prototype setters.
  Object.defineProperty(servers, target, { value: installed, enumerable: true, configurable: true, writable: true })
  await replaceFile(path, text, config, mode)
  return { ...plan, applied: true, backup: resolve(backup) }
}

async function rollbackGroup(receipt, apply) {
  if (typeof receipt.path !== 'string' || !object(receipt.original) || !Object.keys(receipt.original).length
    || typeof receipt.target !== 'string' || !(receipt.project === null || typeof receipt.project === 'string')
    || !object(receipt.installed) || receipt.digest !== digest(receipt.installed)) throw new Error('Invalid rollback receipt.')
  if (receipt.writer === 'claude') return (await claudeWriter(receipt)).rollback(apply)
  const adapter = clientAdapter(receipt.client)
  const { text, config, mode } = await readConfigFile(receipt.path)
  const servers = adapter.servers(config, receipt.project)
  if (!object(servers)) throw new Error('Configuration scope no longer exists.')
  const names = Object.keys(receipt.original)
  if (names.every(n => own(servers, n) && digest(servers[n]) === digest(receipt.original[n]))
    && (names.includes(receipt.target) || !own(servers, receipt.target))) return { restored: true, already_original: true }
  if (!own(servers, receipt.target) || digest(servers[receipt.target]) !== receipt.digest
    || names.some(n => n !== receipt.target && own(servers, n))) throw new Error('Selected connections changed since switching; refusing to overwrite them.')
  if (apply) {
    delete servers[receipt.target]
    for (const [name, entry] of Object.entries(receipt.original)) Object.defineProperty(servers, name, { value: entry, enumerable: true, configurable: true, writable: true })
    await replaceFile(receipt.path, text, config, mode)
  }
  return { restored: apply, servers: names, project: receipt.project }
}
