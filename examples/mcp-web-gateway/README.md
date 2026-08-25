# MCP web gateway contract

This executable contract defines the public routes and response shapes for the
TanStack Start MCP web gateway.

The gateway exposes Better Auth, connection management, OAuth completion, and
one MCP Streamable HTTP route. It does not expose RGAP resources, grants,
tokens, audit records, tool-listing routes, or tool-call routes.

Run the contract from the repository root:

```sh
pnpm --filter @rgap/examples exec tsx mcp-web-gateway/contract.ts
```

The script validates the route allowlist, rejects forbidden route families,
parses representative connection input and output, and confirms that public
connection responses contain no RGAP IDs, RGAP bearers, or upstream OAuth
tokens.

The implementation follows this server-side dispatch:

```text
Better Auth session
        │
        ▼
public connection ID ──► private owner mapping
                              │
                              ▼
                       encrypted RGAP bearer
                              │
                              ▼
POST /mcp/:connectionId ──► @rgap/mcp-proxy ──► RGAP ──► upstream MCP
```

The frontend manages connection names, server URLs, authorization state, and
deletion. MCP methods remain JSON-RPC messages on `/mcp/:connectionId`.
