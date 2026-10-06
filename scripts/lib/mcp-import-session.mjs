import { importDirectory } from './mcp-import-storage.mjs'
import { auditConnections } from './mcp-discovery.mjs'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, lstat, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { clientAdapter, remoteConnection } from './mcp-client-config.mjs'
import { actorEndpoint, parseConfig, switchConnections } from './mcp-import.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const challenge = value => createHash('sha256').update(value).digest('hex')
async function readPrivate(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) throw new Error('Use a regular local file smaller than 5 MiB.')
  return parseConfig(await readFile(path, 'utf8'))
}
async function readSession(path) {
  const stat = await lstat(path)
  if ((stat.mode & 0o077) !== 0) throw new Error('Import session contains credentials; restrict its permissions to 0600.')
  const state = await readPrivate(path)
  if (state.version !== 1 || !state.id || !state.ui || !state.accessSecret || !state.manifest) throw new Error('Invalid import session file.')
  return state
}
async function save(path, state, fresh = false) {
  if (fresh) return writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  // The per-command lock below serializes operations on this session.
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}
async function locked(path, run) {
  const lock = `${path}.lock`
  try { await writeFile(lock, String(process.pid), { mode: 0o600, flag: 'wx' }) }
  catch { throw new Error('Another command is using this import session. If it crashed, remove its .lock file after checking the process has stopped.') }
  try { return await run() } finally { await unlink(lock) }
}
function uiOrigin(value) {
  const url = new URL(value)
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Provide the Actori UI origin only.')
  actorEndpoint(`${url.origin}/mcp`)
  return url.origin
}
export async function startImport({ path, client, names, project = null, ui, session }) {
  const adapter = clientAdapter(client)
  const config = await readPrivate(path), servers = adapter.servers(config, project)
  if (!Array.isArray(names) || !names.length || names.length > 20 || new Set(names).size !== names.length) throw new Error('Select between 1 and 20 distinct --server names.')
  const selected = names.map((name, index) => {
    if (!servers || !Object.hasOwn(servers, name)) throw new Error('Selected server is missing in this scope.')
    const c = remoteConnection(servers[name], client)
    if (c.status === 'unsupported') throw new Error(c.reason)
    return { key: `service-${index + 1}`, name, endpoint: c.endpoint, auth: c.auth }
  })
  const origin = uiOrigin(ui)
  session ??= join(await importDirectory(), 'session.json')
  if (resolve(session) === resolve(path)) throw new Error('Provide a new private --session file outside the client configuration.')
  const verifier = randomBytes(32).toString('base64url'), id = randomUUID()
  const state = { version: 1, authentication: 'oauth', id, ui: origin, workspace: resolve(project ?? process.cwd()), client, path: resolve(path), project, names,
    originalHashes: Object.fromEntries(names.map(n => [n, hash(servers[n])])), verifier,
    accessSecret: randomBytes(32).toString('base64url'), manifest: { version: 1, client, connections: selected } }
  await save(session, state, true)
  return { session: resolve(session), url: `${state.ui}/imports/${id}?challenge=${challenge(verifier)}`, code: challenge(verifier).slice(0, 8).toUpperCase(),
    next: 'Open the link, match the code, and authorize. Then run status with this session file. Selected endpoints will be uploaded; credentials and unrelated configuration stay local.' }
}
async function request(state, suffix = '', body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${state.ui}/api/mcp-imports/${state.id}${suffix}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${state.accessSecret}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}
async function status(state) {
  let result = await request(state)
  if (result.response.status === 401 && state.verifier) {
    const exchange = await request(state, '/exchange', { verifier: state.verifier, access_secret: state.accessSecret })
    if (!exchange.response.ok) throw new Error('Authorize this import in the browser first, or start a new pairing if it expired.')
    result = await request(state)
  }
  if (!result.response.ok) throw new Error('Import access is unavailable or expired. Return to Actori to review this session.')
  if (!result.data.manifest) {
    const uploaded = await request(state, '', state.manifest, 'PUT')
    if (!uploaded.response.ok) throw new Error('The selected connection manifest could not be accepted.')
    result = await request(state)
  }
  return result.data
}
export async function importStatus(session) {
  return locked(session, async () => {
    const state = await readSession(session), result = await status(state)
    delete state.verifier
    await save(session, state)
    return { status: result.status, browser: `${state.ui}/imports/${state.id}`, agent: result.agent_id,
      next: result.status === 'ready' ? 'Run finish to verify and preview the client change.' : 'Connect services and review tools and permissions in the browser.' }
  })
}
async function verifyAgent(endpoint, token, expected) {
  let sequence = 0
  const rpc = async (method, params) => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) })
    if (!response.ok) throw new Error('Actori connection verification failed; configuration was not changed.')
    const payload = await response.json()
    if (payload.error) throw new Error('Actori MCP discovery failed; configuration was not changed.')
    return payload.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'actori-import', version: '1' } })
  const result = await rpc('tools/list', {})
  const actual = new Set((result.tools ?? []).map(t => t.name))
  if (!expected.length || expected.some(name => !actual.has(name))) throw new Error('Actori does not expose every selected action; configuration was not changed.')
}
async function assertAppliedConfiguration(state) {
  const config = await readPrivate(state.path)
  const servers = clientAdapter(state.client).servers(config, state.project)
  const expected = clientAdapter(state.client).connection(state.verifiedEndpoint, state.tokenEnv, state.authentication ?? 'bearer')
  if (!servers || !Object.hasOwn(servers, 'actori') || hash(servers.actori) !== hash(expected)
    || state.names.some(name => name !== 'actori' && Object.hasOwn(servers, name))) {
    throw new Error('The imported configuration was restored or changed. Review it before launching; start a new import to switch again.')
  }
}
export async function finishImport({ session, endpoint, tokenEnv, authentication, backup, apply = false, nativeClient = false }) {
  return locked(session, async () => {
    const state = await readSession(session), ready = await status(state)
    authentication ??= state.authentication ?? (state.tokenEnv ? 'bearer' : 'oauth')
    if (!['oauth', 'bearer'].includes(authentication)) throw new Error('Choose oauth or bearer authentication.')
    if (state.applied && authentication !== (state.authentication ?? 'bearer')) throw new Error('Restore the original configuration before changing authentication mode.')
    tokenEnv ??= state.tokenEnv ?? 'ACTORI_AGENT_TOKEN'
    if (ready.status !== 'ready') throw new Error('Finish service authorization and permission review in the browser first.')
    const config = await readPrivate(state.path), servers = clientAdapter(state.client).servers(config, state.project)
    if (!state.applied && state.names.some(n => !servers || !Object.hasOwn(servers, n) || hash(servers[n]) !== state.originalHashes[n])) throw new Error('A selected connection changed after discovery; start a new import.')
    if (state.applied) await assertAppliedConfiguration(state)
    let verificationToken = state.agentToken, issuedEndpoint = state.endpoint, issuer
    if (authentication === 'oauth' || !verificationToken || Date.parse(state.tokenExpiresAt) <= Date.now()) {
      const issued = await request(state, '/credential', { authentication })
      if (!issued.response.ok) throw new Error(issued.data.error ?? 'Could not prepare client authentication.')
      if (authentication === 'oauth' && issued.data.authentication !== 'oauth') throw new Error('The server does not support OAuth import setup yet.')
      verificationToken = issued.data.token; issuedEndpoint = issued.data.endpoint; issuer = issued.data.issuer
      if (authentication === 'bearer') {
        state.agentToken = verificationToken; state.tokenExpiresAt = issued.data.expires_at; state.endpoint = issuedEndpoint
        await save(session, state)
      }
    }
    const target = actorEndpoint(endpoint ?? state.verifiedEndpoint ?? issuedEndpoint)
    if (state.verifiedEndpoint && state.verifiedEndpoint !== target) throw new Error('This session was verified for another Actori endpoint.')
    if (authentication === 'oauth') {
      // OAuth's resource/audience must match the URL the native client dials.
      // Do not silently fall back to a wrapper if discovery is unavailable.
      if (target !== actorEndpoint(issuedEndpoint)) throw new Error('OAuth requires the configured MCP resource URL; endpoint overrides must match it.')
      const metadata = await fetch(new URL('/.well-known/oauth-protected-resource', target), { redirect: 'error', signal: AbortSignal.timeout(30000) })
      const resource = await metadata.json().catch(() => ({}))
      if (!metadata.ok || resource.resource !== target || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(issuer)) throw new Error('Actori OAuth discovery does not match this import; configuration was not changed.')
    }
    const expected = Object.values(ready.progress).flatMap(p => p.actions ?? []).map(a => a.name)
    await verifyAgent(target, verificationToken, expected)
    if (state.applied && authentication === 'bearer' && state.tokenEnv !== tokenEnv) throw new Error('The applied configuration uses another token environment variable.')
    state.verifiedEndpoint = target; state.authentication = authentication
    if (authentication === 'oauth') { delete state.agentToken; delete state.tokenExpiresAt; delete state.tokenEnv }
    else state.tokenEnv = tokenEnv
    const next = authentication === 'oauth'
      ? 'Launch your client normally in the selected project. Authorize Actori once in its MCP settings, then verify a real task, approval and denial. The client manages OAuth credentials; no launch wrapper is required.'
      : 'Diagnostic bearer mode: use launch with this session file to supply the token. Normal client startup will not inherit it.'
    if (state.applied) { await assertAppliedConfiguration(state); await save(session, state); return { applied: true, already_applied: true, governance_verified: false, backup: state.backup, next } }
    if (apply && !backup) backup = join(await importDirectory(), 'rollback.json')
    const result = await switchConnections({ path: state.path, client: state.client, project: state.project, names: state.names, endpoint: target, tokenEnv, authentication, backup, apply, nativeClient }).catch(async error => {
      if (apply && backup && await lstat(backup).then(() => true, () => false)) {
        throw new Error(`${error.message} Recovery receipt: ${resolve(backup)}`)
      }
      throw error
    })
    state.applied = apply; if (apply) state.backup = resolve(backup)
    await save(session, state)
    return { ...result, verified: true, governance_verified: false, required_next_step: 'Restart, audit remaining routes, and verify client enforcement before reporting setup complete.', tools: expected, authentication, ...(authentication === 'bearer' ? { token_expires_at: state.tokenExpiresAt } : { client_authorization: 'pending_native_sign_in' }),
      next: apply ? next : nativeClient ? 'Review this preview, then apply with --native-client --apply (optionally --backup NEW_RECEIPT_FILE). Restart Claude before using the new connection.' : 'Review this preview, stop the client, then repeat with --apply (optionally --backup NEW_RECEIPT_FILE).' }
  })
}
export async function launchClient(session, args) {
  const state = await readSession(session)
  if (!state.applied || ((state.authentication ?? 'bearer') === 'bearer' && (!state.agentToken || Date.parse(state.tokenExpiresAt) <= Date.now()))) throw new Error('Apply the import and obtain an unexpired agent token first.')
  await assertAppliedConfiguration(state)
  if (!args.length) throw new Error('Provide the client command after --.')
  // No shell evaluation. The token is only in the child's environment, not
  // argv, logs, project configuration, or an export command in shell history.
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: state.authentication === 'oauth' ? process.env : { ...process.env, [state.tokenEnv]: state.agentToken } })
    child.on('error', () => reject(new Error('Unable to launch the client command.')))
    child.on('exit', (code, signal) => resolvePromise({ exit_code: code ?? 1, ...(signal ? { signal } : {}) }))
  })
}

export async function resumeImport(session) {
  return locked(session, async () => {
    const state = await readSession(session)
    state.verifier = randomBytes(32).toString('base64url')
    state.accessSecret = randomBytes(32).toString('base64url')
    await save(session, state)
    return { url: `${state.ui}/imports/${state.id}?challenge=${challenge(state.verifier)}`, code: challenge(state.verifier).slice(0, 8).toUpperCase(),
      next: 'Reauthorize this pairing in the browser, then run status. Existing service setup is retained.' }
  })
}

export async function auditImport({ session, project, pluginConfigs = [] }) {
  const state = await readSession(session)
  return auditConnections({ client: state.client, project: project ?? state.workspace ?? state.project ?? process.cwd(), pluginConfigs, selected: state.manifest.connections, endpoint: state.verifiedEndpoint })
}
