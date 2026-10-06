#!/usr/bin/env node
import { discoverConnections } from './lib/mcp-discovery.mjs'
import { parseArgs } from 'node:util'
import { auditImport, startImport, resumeImport, importStatus, finishImport, launchClient } from './lib/mcp-import-session.mjs'
import { scanFile, rollbackConnection } from './lib/mcp-import.mjs'

const help = `Actori MCP connection import (Node.js 22+)

Usage: actori-import COMMAND [OPTIONS]

discover --client claude-code|cursor [--project PROJECT_DIR] [--plugin-config FILE ...]
start    --client claude-code|cursor --config FILE --server NAME [--server NAME ...]
         [--project ABSOLUTE_PROJECT_PATH] --ui ACTORI_UI_ORIGIN [--session NEW_PRIVATE_FILE]
audit    --session PRIVATE_FILE [--project PROJECT_DIR] [--plugin-config FILE ...]
status   --session PRIVATE_FILE
resume   --session PRIVATE_FILE
finish   --session PRIVATE_FILE [--endpoint ACTORI_MCP_URL]
         [--authentication oauth|bearer] [--token-env ACTORI_AGENT_TOKEN] [--native-client] [--apply] [--backup NEW_RECEIPT_FILE]
launch   --session PRIVATE_FILE -- CLIENT_COMMAND [ARGS...]

scan     --config FILE [--client claude-code|cursor]
rollback --backup RECEIPT_FILE [--apply]

start/finish support selected remote HTTPS connections in Claude Code and Cursor.
Services use browser OAuth discovery, no auth, or a separately entered bearer token. Additional settings are reported unsupported. Use scan to find
the exact server name and scope. Omit --project for top-level entries.
New sessions and automatic rollback receipts default to private ~/.actori/imports
directories. Explicit paths are supported. Keep them outside version control.
audit reports remaining local routes and checks still needed in the live client;
it never certifies that cloud/plugin routes or other service access are absent.
start writes a local session and prints a browser link. status uploads only your
selected endpoint manifest after browser pairing. finish verifies Actori tools
before preview/apply. OAuth is the default: authorize Actori once in your client,
then launch Claude or Cursor normally. No token is stored in client config.
Explicit --authentication bearer retains the launch wrapper for diagnostics.

Use --native-client for URL-only Claude HTTP entries: Claude writes the config;
restart afterward. Other writes require a stopped client. Rollback previews by
default and uses native commands automatically for native receipts.
Only the selected file/scope changes; review other scopes and plugin routes.
`

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(['config', 'project', 'endpoint', 'token-env', 'backup', 'ui', 'client', 'session', 'authentication'].map(key => [key, { type: 'string' }])
      .concat([['native-client', { type: 'boolean' }], ['plugin-config', { type: 'string', multiple: true }], ['server', { type: 'string', multiple: true }], ['apply', { type: 'boolean' }], ['help', { type: 'boolean' }]])),
  })
  const [command] = positionals
  if (values.help || !command) console.log(help)
  else {
    if (command !== 'launch' && positionals.length !== 1) throw new Error('Provide exactly one command.')
    let result
    if (command === 'discover' && values.client) result = await discoverConnections({ client: values.client, project: values.project, pluginConfigs: values['plugin-config'] })
    else if (command === 'start' && values.config && values.server && values.ui && values.client) result = await startImport({ path: values.config, client: values.client, names: values.server, project: values.project, ui: values.ui, session: values.session })
    else if (command === 'resume' && values.session) result = await resumeImport(values.session)
    else if (command === 'audit' && values.session) result = await auditImport({ session: values.session, project: values.project, pluginConfigs: values['plugin-config'] })
    else if (command === 'status' && values.session) result = await importStatus(values.session)
    else if (command === 'finish' && values.session) result = await finishImport({ session: values.session, endpoint: values.endpoint, tokenEnv: values['token-env'], authentication: values.authentication, backup: values.backup, apply: values.apply, nativeClient: values['native-client'] })
    else if (command === 'launch' && values.session) result = await launchClient(values.session, positionals.slice(1))
    else if (command === 'scan' && values.config) result = await scanFile(values.config, values.client ?? 'claude-code')
    else if (command === 'rollback' && values.backup) result = await rollbackConnection(values.backup, values.apply)
    else throw new Error('Missing or invalid command options; use --help.')
    if (command === 'launch') process.exitCode = result.exit_code
    else console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  // JSON parser contents and raw config are never surfaced by the library.
  console.error(error instanceof Error ? error.message : 'Import operation failed.')
  process.exitCode = 1
}
