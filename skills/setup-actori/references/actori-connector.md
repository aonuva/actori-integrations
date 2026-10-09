# Actori connector setup and diagnostics

Use only management tools present in the live client, in the intended deployment and Account. Match advertised schemas and `_meta.target`. Owner permissions and agent grants both apply; the connector calls existing console routes as the owner and records the acting agent.

| Need | Existing tools / human step |
| --- | --- |
| Find service support | `list_connector_catalog`; inspect supported auth and fields |
| Resume without duplicates | `list_connectors`; match the chosen connector ID and instance |
| Add non-secret connection | `add_connector`; human finishes OAuth at returned console URL |
| API key / credential | Human creates or edits the connector in the console; no secrets in MCP arguments |
| Discover provider tools | `sync_connector_tools` after consent |
| Select tools and access | Human selects tools and agent role in connector bulk-add, then configures approval policy and approver role on each action |
| Diagnose missing access | `get_agent_permissions`, `list_actions`, `get_action`, `list_action_policies`, `list_roles`, `list_grants` as available |
| Pending/failed execution | `get_approval`, `get_execution`; fetch the original result via `check_approval_status` |

There is no `add_actions` or approval-decision tool. Do not request or perform self-grants. Missing management access is a console bootstrap step, not a reason to use an admin token. Read operations can also need approval. Follow the returned request once; ambiguous write errors require checking server state before retrying.

Lists may be capped, and management reads deliberately omit other calls' arguments/results. A sanitized empty output is not evidence that upstream execution did not happen. Inspect only relevant IDs and filters. Credential failures, unsupported provider auth, and insufficient permissions should leave local routing unchanged until resolved.
