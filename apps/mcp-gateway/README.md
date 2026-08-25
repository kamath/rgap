# RGAP MCP gateway

This TanStack Start application owns Better Auth, the connection dashboard,
and the public connection-management routes. It delegates MCP protocol and
upstream OAuth behavior to `@rgap/mcp-proxy`.

```bash
BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
GATEWAY_BEARER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
PUBLIC_BASE_URL=http://127.0.0.1:3004 \
pnpm --filter @rgap/mcp-gateway dev
```

Open `http://127.0.0.1:3004`, create an account, and add an MCP server.
Development data is stored under `apps/mcp-gateway/.data`.

The public product surface is:

- Better Auth at `/api/auth/*`;
- connection management at `/api/connections`;
- MCP request-response transport at `POST /mcp/:connectionId`; and
- upstream OAuth completion and metadata under `/oauth`.

The app does not mount `@rgap/server` and does not expose REST tool-listing or
tool-call routes. Better Auth is an application dependency only;
`@rgap/mcp-proxy` remains independent of it.
