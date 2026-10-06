# Actori integrations

Bring existing Claude Code or Cursor remote MCP connections into Actori, with reviewed tool permissions, human approvals, and reversible configuration changes. Provider-independent; no service credentials are copied from client configuration.

## Install

Requires Node.js 22+ and a compatible Actori deployment with the MCP import APIs and client OAuth enabled. The initial release targets the importer API introduced by actori-app PR #28; older deployments may not support it.

Install a pinned release (no source checkout needed):

```sh
npx --yes --package=https://github.com/aonuva/actori-integrations/releases/download/v0.1.0/aonuva-actori-integrations-0.1.0.tgz actori-setup --client claude-code
```

For Cursor, replace `claude-code` with `cursor`. Restart your client after installation. The installer copies the runtime into your personal skill directory so it keeps working after npm's cache is cleared. It refuses to overwrite an existing skill. Installation does not change MCP connections.

## First governed task

1. Open your project in Claude Code or Cursor and ask: “Use setup-actori to connect this project to Actori at MY_ACTORI_URL. Discover connections and let me choose before changing anything.” Replace the URL with your Actori dashboard origin.
2. Select a supported service and review the exact file and scope. User-level configuration affects other projects.
3. Open the pairing link, match the code, sign in, and authorize the importer. Tell the agent when pairing is complete so it uploads the selected endpoints.
4. Connect the service in Actori. OAuth requires new provider consent; bearer credentials belong in the browser, never chat. Select a read-only tool requiring approval and a role you belong to as approver.
5. Review shared access: repeated imports reuse your existing Actori agent, and added permissions apply to every client using it. Same-service imports currently create separate connectors/tool names.
6. Approve the configuration preview. Claude can use native configuration commands; Cursor requires quitting affected sessions and running the supplied apply command externally. Keep the rollback receipt.
7. Restart normally and authenticate Actori in the client's MCP settings. Call the selected tool once, approve in Actori, and retrieve the result of the same request without resubmitting.
8. Review alternate direct connections/plugins. Test rejection or an explicit deny policy separately. Actori governs calls routed through it; it does not sandbox shell or network access.

## Recovery and removal

Ask setup-actori to resume using the saved session path. Expired pairing can be renewed with `resume`; reconnect providers in the same import. Sessions and receipts default to `~/.actori/imports/` and must remain private.

Ask the skill to preview and apply rollback using the saved receipt. Stop affected clients for non-native writes, then restart. Rollback restores selected entries only; conflicts stop rather than overwrite unrelated edits. It does not remove server-side grants or provider consent, which may be shared by other clients.

To uninstall the skill, first finish or roll back active imports, then remove only the installed `setup-actori` directory under `~/.claude/skills/` or `~/.cursor/skills/`. Retain receipts until restoration is verified. Upgrades currently require moving the old skill aside and installing the new pinned release.

## Supported scope

Remote HTTPS Streamable HTTP tools in Claude Code and Cursor. Provider OAuth discovery, unauthenticated endpoints, and separately supplied bearer tokens are supported. Local-process MCPs, arbitrary custom headers, cloud connectors, resources/prompts, and plugin behavior are not migrated. Existing credentials are not transferred. Separate Actori agents through the same human OAuth identity remain a server-side limitation.

## Development

No runtime dependencies. Run `npm test`; run `npm pack` to build the distributable. CLI: `node scripts/mcp-import.mjs --help`. Tests use temporary configurations and mock services; they do not need your accounts.

Report issues here without tokens, session files, receipts, or raw personal configuration. Core UI, provider credential storage, permissions, and approval enforcement remain in Actori's app repository.
