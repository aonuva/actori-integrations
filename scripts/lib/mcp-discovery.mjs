import { readFile, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clientAdapter, connectionInventory } from './mcp-client-config.mjs'
import { parseConfig } from './mcp-import.mjs'

/** Inspect known client files and explicitly selected plugin definitions only.
 * Never execute a discovered command or read OAuth token caches. */
export async function discoverConnections({ client, project = process.cwd(), home, pluginConfigs = [] }) {
  const adapter = clientAdapter(client)
  const files = [...new Set(adapter.paths(project, home).map(resolvePath))]
  const plugins = new Set(pluginConfigs.map(resolvePath))
  const sources = []
  for (const path of new Set([...files, ...plugins])) {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) {
        sources.push({ path, status: 'unsupported', reason: 'Use a regular configuration file smaller than 5 MiB.' }); continue
      }
      const raw = parseConfig(await readFile(path, 'utf8'))
      // Claude plugin .mcp.json can be a server-name map or mcpServers.
      const config = plugins.has(path) && !Object.hasOwn(raw, 'mcpServers') ? { mcpServers: raw } : raw
      const inventory = connectionInventory(config, client)
      sources.push({ path, status: 'found', plugin: plugins.has(path), connections: inventory.connections,
        ...(plugins.has(path) ? { warning: 'Read-only plugin inventory. Disable its direct route in the client before claiming cutover; plugin files are not rewritten.' } : {}) })
    } catch (error) {
      sources.push({ path, status: error?.code === 'ENOENT' ? 'missing' : 'unreadable', ...(error?.code === 'ENOENT' ? {} : { reason: 'Could not safely read this configuration.' }) })
    }
  }
  const byName = new Map()
  for (const source of sources) for (const connection of source.connections ?? []) {
    const locations = byName.get(connection.name) ?? []
    locations.push({ path: source.path, project: connection.project }); byName.set(connection.name, locations)
  }
  return { client, sources, conflicts: [...byName].filter(([, locations]) => locations.length > 1).map(([name, locations]) => ({ name, locations })),
    warnings: ['Choose an explicit file and scope for import. Duplicate names may override one another in the client.',
      'Plugin inventory is limited to the definitions supplied with --plugin-config. Skills, hooks, cloud settings and OAuth caches are not imported.',
      'After cutover, review every remaining direct route. Actori controls only calls routed through its endpoint.'] }
}
function resolvePath(path) { return resolve(path) }

/** A local configuration audit is not proof of all capabilities in a live client.
 * Names/endpoint matches are hints; cloud routes and scripts need human review. */
export async function auditConnections({ client, project = process.cwd(), home, pluginConfigs = [], selected, endpoint }) {
  const inventory = await discoverConnections({ client, project, home, pluginConfigs })
  const routes = [], otherProjects = [], unreadable = []
  for (const source of inventory.sources) {
    if (source.status === 'missing') continue
    if (source.status !== 'found') { unreadable.push(source.path); continue }
    // Re-read only the same bounded, regular files used by discovery. Do not
    // include URL/header values in the report.
    try {
      const stat = await lstat(source.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) { unreadable.push(source.path); continue }
      const raw = parseConfig(await readFile(source.path, 'utf8'))
      const config = source.plugin && !Object.hasOwn(raw, 'mcpServers') ? { mcpServers: raw } : raw
      for (const scope of clientAdapter(client).scopes(config)) {
        for (const [name, entry] of Object.entries(scope.servers)) {
          if (endpoint && entry?.url === endpoint && name === 'actori' && !source.plugin) continue
          const reference = { name, path: source.path, project: scope.project, plugin: !!source.plugin }
          if (scope.project && resolve(scope.project) !== resolve(project)) { otherProjects.push(reference); continue }
          const matches = selected.some(s => s.endpoint === entry?.url || s.name.toLowerCase() === name.toLowerCase())
          routes.push({ ...reference, assessment: matches ? 'possible_bypass' : 'review_service_access',
            reason: matches ? 'Matches a selected service name or endpoint.' : 'Review whether this remaining connection can access the selected service, including local scripts or proxies.' })
        }
      }
    } catch { unreadable.push(source.path) }
  }
  return { client, project: resolve(project), status: routes.some(r => r.assessment === 'possible_bypass') ? 'direct_routes_remaining' : 'client_review_required',
    governance_verified: false, remaining_routes: routes, other_project_routes: otherProjects, unreadable_sources: unreadable,
    required_checks: ['Restart the client after configuration changes and inspect its active MCP tools.',
      'Review cloud connectors and enabled plugins in the client; local discovery cannot establish their absence.',
      'Disable selected-service bypass routes after Actori login and a real read succeed; confirm shared-scope changes with the user.',
      'Verify an explicitly denied read through Actori cannot execute upstream. Never test denial by risking a write.',
      'Report only the reviewed client/project/service scope; configuration audit alone does not establish exclusive access.'] }
}
