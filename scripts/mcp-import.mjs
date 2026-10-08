#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { discoverConnections, auditConnections } from './lib/mcp-discovery.mjs'
import { scanFile, planConnections, rollbackConnection, switchConnections } from './lib/mcp-import.mjs'
import { importDirectory } from './lib/mcp-import-storage.mjs'

const help = `Actori MCP setup (Node.js 22+)

The client signs into Actori through native OAuth. The setup-actori skill uses
Actori connector tools; service credentials and access grants stay in the console.
This CLI only reads and changes local configuration. It never signs into Actori.

discover --client claude-code|cursor [--project DIR] [--plugin-config FILE ...]
scan     --client CLIENT --config FILE
plan     --client CLIENT --config FILE --server NAME [--project CLAUDE_SCOPE]
switch   --client CLIENT --config FILE --server NAME [--server NAME ...]
         --endpoint ACTORI_MCP_URL [--project ABSOLUTE_CLAUDE_SCOPE]
         [--native-client] [--apply] [--backup NEW_RECEIPT_FILE]
audit    --client CLIENT --server NAME [--server NAME ...] --endpoint ACTORI_MCP_URL
         [--project DIR] [--plugin-config FILE ...]
rollback --backup RECEIPT_FILE [--apply]

Bootstrap Actori in your client first. Re-list its tools after the person grants
service access. Only then preview switch and apply the reviewed change.
Switch previews by default and creates a private durable rollback receipt on
apply. An identical existing Actori entry is preserved, including on rollback.
Native mode delegates URL-only Claude changes to Claude's own MCP commands.
For Cursor or other file writes, close the affected client before --apply.
Restart afterward. Audit cannot prove absence of cloud/plugin or shell routes.
Legacy version-2 rollback receipts are supported. start/status/resume/finish/
launch are retired: they require the removed app-side import-session mechanism.
`
try {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    client: { type: 'string' }, config: { type: 'string' }, project: { type: 'string' },
    endpoint: { type: 'string' }, backup: { type: 'string' }, server: { type: 'string', multiple: true },
    'plugin-config': { type: 'string', multiple: true }, 'native-client': { type: 'boolean' },
    apply: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  const [command] = positionals
  if (!command || v.help) console.log(help)
  else {
    if (positionals.length !== 1) throw new Error('Provide exactly one command.')
    let result
    if (command === 'discover' && v.client) result = await discoverConnections({ client: v.client, project: v.project, pluginConfigs: v['plugin-config'] })
    else if (command === 'scan' && v.config) result = await scanFile(v.config, v.client ?? 'claude-code')
    else if (command === 'plan' && v.client && v.config && v.server) result = await planConnections({ path: v.config, client: v.client, names: v.server, project: v.project })
    else if (command === 'switch' && v.client && v.config && v.server && v.endpoint) {
      const options = { path: v.config, client: v.client, names: v.server, endpoint: v.endpoint, project: v.project, authentication: 'oauth', nativeClient: v['native-client'] }
      // Validate before allocating a receipt directory or making any write.
      result = await switchConnections(options)
      if (v.apply) result = await switchConnections({ ...options, apply: true, backup: v.backup ?? join(await importDirectory(), 'rollback.json') })
    } else if (command === 'audit' && v.client && v.server && v.endpoint) result = await auditConnections({ client: v.client, project: v.project, pluginConfigs: v['plugin-config'], endpoint: v.endpoint, selected: v.server.map(name => ({ name })) })
    else if (command === 'rollback' && v.backup) result = await rollbackConnection(v.backup, v.apply)
    else throw new Error('Missing options or retired command. Use --help; setup now uses the Actori connector and native client OAuth.')
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local setup operation failed.')
  process.exitCode = 1
}
