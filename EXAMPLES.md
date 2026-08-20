# RGAP Examples

This document shows how RGAP governs MCP servers, aggregates tools for an agent, and downscopes authority for sub-agents.

## MCP server governance

RGAP treats MCP servers and their exposed capabilities as resources. A deployment registers every trusted server beneath an administrative resource and assigns stable IDs to servers, tools, prompts, and MCP resources.

```text
acme/
└── mcp/
    ├── google-drive/
    │   └── tools/
    │       ├── search_files
    │       └── read_file
    ├── slack/
    │   └── tools/
    │       ├── search_messages
    │       └── post_message
    └── github/
        └── tools/
            ├── read_issue
            └── create_issue
```

The MCP server resource is the high-level governance boundary. An operator can register, disable, or revoke an entire server branch. Tool-level capability entries determine which operations an agent can actually invoke. Registering or discovering a tool does not grant access to it.

Server-wide grants explicitly state whether they include tools registered later. The safe default excludes new descendants so a server update cannot silently add authority to an existing agent.

### Aggregating tools for an agent

A coordinator agent receives one grant containing selected tools from several MCP servers:

```yaml
id: grant_coordinator
capabilities:
  - resource_id: tool_drive_search_files
    permissions: [invoke]
    constraints:
      drive_roots: [folder_project_alpha]
      result_limit: 50
  - resource_id: tool_slack_search_messages
    permissions: [invoke]
    constraints:
      channels: [channel_project_alpha, channel_engineering]
  - resource_id: tool_github_create_issue
    permissions: [invoke]
    constraints:
      repositories: [repo_alpha]
expires_at: 2026-08-20T23:00:00Z
```

This is aggregation: one credential represents an explicitly selected set of tool capabilities without exposing the OAuth tokens, API keys, or other credentials used by those tools.

### Downscoping to sub-agents

The coordinator delegates a narrower grant to a research sub-agent:

```yaml
id: grant_researcher
parent_grant_id: grant_coordinator
capabilities:
  - resource_id: tool_drive_search_files
    permissions: [invoke]
    constraints:
      drive_roots: [folder_project_alpha_docs]
      result_limit: 10
  - resource_id: tool_slack_search_messages
    permissions: [invoke]
    constraints:
      channels: [channel_project_alpha]
expires_at: 2026-08-20T22:00:00Z
```

The research sub-agent cannot create GitHub issues, search the engineering Slack channel, search outside the project documentation folder, return more than ten results, or operate after its parent grant expires. It can delegate again only within this reduced envelope.

### MCP gateway walkthrough

1. The platform registers trusted MCP servers and synchronizes their tools as stable resources.
2. The user or an authorized policy selects tools and constraints for the coordinator grant.
3. The coordinator receives an opaque RGAP token, while provider credentials remain inside the MCP gateway or tool runtime.
4. An MCP `tools/list` response includes only tools visible through the active grant.
5. For `tools/call`, the gateway maps the server and tool name to stable resource IDs, validates the requested arguments against the capability constraints, and checks every ancestor grant.
6. The gateway retrieves the protected provider credential, invokes the MCP server, and records the grant lineage and decision in the audit log.
7. A sub-agent receives a new token referencing a child grant rather than receiving the coordinator's token or an upstream provider credential.
8. Revoking the coordinator grant immediately disables the coordinator and every sub-agent descended from it.

The same enforcement model applies to MCP resources and prompts when a deployment exposes them. The gateway is the policy-enforcement point; an agent cannot bypass a narrow RGAP grant by obtaining the underlying provider credential.

At the integration boundary, the gateway translates MCP discovery into resource creation, calls `authorize` before exposing or invoking a tool, and calls `delegate` when an agent creates a sub-agent.
