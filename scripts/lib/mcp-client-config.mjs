import { homedir } from 'node:os'
import { resolve, join, isAbsolute } from 'node:path'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
export const CLIENTS = ['claude-code', 'cursor']

export function clientAdapter(client = 'claude-code') {
  if (!CLIENTS.includes(client)) throw new Error('Choose claude-code or cursor.')
  return {
    client,
    paths(project = process.cwd(), home) {
      const claudeConfig = home === undefined && process.env.CLAUDE_CONFIG_DIR
        ? join(resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json') : join(home ?? homedir(), '.claude.json')
      home ??= homedir()
      return client === 'cursor'
        ? [join(home, '.cursor', 'mcp.json'), join(resolve(project), '.cursor', 'mcp.json')]
        : [claudeConfig, join(resolve(project), '.mcp.json')]
    },
    scopes(config) {
      const scopes = [{ project: null, servers: config.mcpServers }]
      if (client === 'claude-code' && object(config.projects)) {
        for (const [project, value] of Object.entries(config.projects)) {
          if (object(value) && isAbsolute(project)) scopes.push({ project, servers: value.mcpServers })
        }
      }
      return scopes.filter(scope => object(scope.servers))
    },
    servers(config, project = null) {
      if (project && (client !== 'claude-code' || !isAbsolute(project))) {
        throw new Error('Nested project scope requires Claude Code and an absolute project path.')
      }
      if (!project) return config.mcpServers
      return object(config.projects) && own(config.projects, project) ? config.projects[project]?.mcpServers : undefined
    },
    connection(endpoint, tokenEnv, authentication = 'bearer') {
      if (authentication === 'oauth') return client === 'cursor' ? { url: endpoint } : { type: 'http', url: endpoint }
      return client === 'cursor'
        ? { url: endpoint, headers: { Authorization: `Bearer \${env:${tokenEnv}}` } }
        : { type: 'http', url: endpoint, headers: { Authorization: `Bearer \${${tokenEnv}}` } }
    },
  }
}

// Classifies configuration only. Network/auth compatibility is verified during
// setup, never inferred from the presence of a URL or a provider's name.
export function remoteConnection(entry, client = 'claude-code') {
  clientAdapter(client)
  const unsupported = reason => ({ status: 'unsupported', reason })
  if (!object(entry)) return unsupported('Connection must be an object.')
  if (own(entry, 'command') || entry.type === 'stdio') return unsupported('Local process requires a bridge; no command was executed.')
  if (client === 'claude-code' && entry.type === undefined) return unsupported('Claude Code remote entries need an explicit type: http so the original route works after rollback.')
  if (entry.type !== undefined && entry.type !== 'http') return unsupported('Only remote Streamable HTTP is supported.')
  if (Object.keys(entry).some(key => !['type', 'url', 'headers'].includes(key))) return unsupported('Additional client settings require a compatibility review.')
  let url
  try { url = new URL(entry.url) } catch { return unsupported('A resolved HTTPS endpoint is required.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[{}]/.test(entry.url)) {
    return unsupported('Use an HTTPS endpoint without embedded credentials, query parameters, or unresolved variables.')
  }
  if (entry.headers !== undefined && !object(entry.headers)) return unsupported('Headers must be an object.')
  const headers = Object.entries(entry.headers ?? {})
  if (headers.length > 1 || headers.some(([key]) => key.toLowerCase() !== 'authorization')) return unsupported('Custom headers require an explicit supported mapping.')
  let auth = 'discover', credentialEnv = null
  if (headers.length) {
    const value = headers[0][1]
    if (typeof value !== 'string' || !/^Bearer .+$/i.test(value)) return unsupported('Only bearer authorization headers are supported.')
    const bearer = value.slice(7)
    const pattern = client === 'cursor' ? /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/ : /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
    const match = pattern.exec(bearer)
    if (/[{}]/.test(bearer) && !match) return unsupported('Unsupported credential interpolation; provide the credential separately in Actori.')
    credentialEnv = match?.[1] ?? null
    auth = 'bearer'
  }
  return { status: 'setup_required', transport: 'http', auth, credentialEnv,
    provider: url.href === 'https://mcp.notion.com/mcp' ? 'notion-mcp' : 'custom-mcp',
    // Endpoint stays in the local plan, not the public inventory/log output.
    endpoint: url.href }
}

export function connectionInventory(config, client = 'claude-code', env = process.env) {
  return { version: 2, client, connections: clientAdapter(client).scopes(config).flatMap(({ project, servers }) =>
    Object.entries(servers).map(([name, entry]) => {
      const { endpoint: _endpoint, ...classification } = remoteConnection(entry, client)
      return { name, project, ...classification,
        ...(classification.credentialEnv ? { credentialAvailable: typeof env[classification.credentialEnv] === 'string' && env[classification.credentialEnv].length > 0 } : {}) }
    })), warnings: ['Only the supplied configuration is inventoried. Other scopes, plugin-managed and cloud connections may remain direct.'] }
}
