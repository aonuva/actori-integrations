# Actori integrations

Open-source local MCP discovery, reversible client configuration, and the
`setup-actori` skill for Claude Code and Cursor. Node.js 22+, MIT licensed.

## Connector-based setup (0.2)

This revision uses the existing Actori connector and native client OAuth. It
needs no new importer API, pairing credential or token launcher. It replaces the
unreleased app-side session mechanism used by the older v0.1.1 package.

From this source checkout, install once:

```sh
node scripts/install-setup-skill.mjs --client claude-code
# or --client cursor
```

The installer copies the skill and runtime into your personal skill directory;
the checkout can then be removed. It refuses to overwrite an existing skill:
move the old skill aside first, keeping rollback receipts. This version has not
yet been published as a release; do not use the v0.1.1 tarball for this flow.

Restart the client and ask:

> Use setup-actori to connect this project to Actori at MY_CONSOLE_URL. Discover
> my MCP connections, explain which are supported, and let me choose. Start with
> one service and one read-only task requiring approval.

The skill guides the human through initial Actori OAuth and management-tool
grants, then uses `add_connector` and `sync_connector_tools`. Provider consent,
API tokens, tool selection, policies and approvers stay in the existing console.
Agents cannot widen their own access. All clients on one agent share its grants.

## Local commands

```sh
node scripts/mcp-import.mjs discover --client claude-code --project /absolute/project
node scripts/mcp-import.mjs switch --client claude-code --config /absolute/project/.mcp.json \
  --server docs --endpoint https://YOUR_ACTORI_AGENT_HOST/mcp --native-client
```

After live Actori tool discovery and review, repeat with `--apply`. Cursor and
non-native file writes require closing affected client sessions first. Apply
prints a private durable rollback receipt. It edits only the selected scope,
keeps unrelated entries, and preserves an identical pre-existing Actori entry.
It does not verify server access or transfer credentials.

```sh
node scripts/mcp-import.mjs rollback --backup /private/path/rollback.json
# After reviewing the preview, repeat with --apply.
```

Version-2 receipts from 0.1 remain supported. Retired session commands fail with
an explanation; keep the old release only if finishing an old isolated trial.
Local rollback does not delete shared Actori resources or revoke consent.

## Boundaries and checks

Supported: remote HTTPS Streamable HTTP definitions, browser-authorized services
and bearer credentials entered separately in Actori. Unknown OAuth services need
a supported OAuth catalog entry. Local processes, custom headers, cloud plugins,
resources and prompts are not automatically migrated. Review alternate direct
routes; the configuration audit cannot certify network isolation.

`npm test` covers discovery/redaction, scope-preserving writes, native Claude
commands, receipts/rollback, and durable skill installation using isolated files.
Live connector bootstrap, provider consent, grants and client execution must be
verified against a configured Actori deployment. Old session-flow UAT does not
establish this revised flow's end-to-end acceptance.
