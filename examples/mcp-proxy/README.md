# Mountable OAuth MCP proxy

This example mounts the Hono app from `@rgap/mcp-proxy`, whose source lives in
`packages/examples/mcp-proxy`. The package represents remote Streamable HTTP
MCP servers as executable RGAP connections while the example owns deployment
configuration, storage, resource provisioning, and process lifecycle.

The package uses two factories because the MCP runtime must exist when the RGAP
store is constructed:

```ts
const mcp = createMcpProxyRuntime({
  publicBaseUrl,
  credentialStore,
  flowStore,
});
const store = new SqliteRgapStore({
  url: 'rgap.db',
  runtimes: { mcp: mcp.runtime },
});

const app = new Hono();
app.route('/integrations/mcp', createMcpProxyApp({ mcp, store }));
```

`createMcpProxyApp` exposes `POST /mcp/:connectionId`,
`GET /oauth/callback`, and `GET /oauth/client-metadata.json`, relative to its
mount point. It does not mount the RGAP API. The MCP route uses the request
bearer and supplied store to invoke the selected connection through RGAP.
`publicBaseUrl` is the externally visible URL of that mount point. For the
example above it is `https://example.com/integrations/mcp`.
The configured public URL and Hono mount path must match.

Host code manages gateway servers without exposing generic RGAP routes:

```ts
const servers = mcp.servers(store.admin());
const registration = await servers.create({
  name: 'example',
  serverUrl: new URL('https://mcp.example.com'),
});
await servers.update(registration.server.id, {
  serverUrl: new URL('https://mcp2.example.com'),
});
await servers.delete(registration.server.id);
```

Pass `store.as(operatorToken)` instead of `store.admin()` to enforce delegated
management authority. A web application can call this service from Next.js
server actions, TanStack Start server functions, or private management routes.

The server definition, authenticated connection, and credential are separate
resources:

```text
acme/mcp/
├── servers/<server>
├── connections/<server>-default
└── credentials/<server>-default
```

The connection seals the upstream URL and binds both the server identity and
credential resources. An RGAP grant with `invoke` on that connection can
forward any client-to-server MCP request supported by the negotiated protocol.
The MCP SDK manages connection setup and protocol negotiation.

OAuth tokens, registered client information, discovery state, PKCE data, and
credential-bound pending authorization are stored through
the `SecretStore` interface from `@rgap/secret-store`. This example uses
`SqliteSecretStore` from `@rgap/secret-store-sqlite` to keep them in
`credentials.db` under the credential resource ID. The browser callback
validates state and expiry before asking the MCP SDK to validate the issuer and
exchange the authorization code.

`@rgap/oauth-store` provides the callback lookup store interface.
`SqliteOAuthFlowStore` from `@rgap/oauth-store-sqlite` keys pending callback
records by a SHA-256 hash of state in `oauth-flows.db`. Claiming one is atomic
and one-time. A replicated deployment supplies shared implementations of the
OAuth and secret store interfaces.

Start the proxy:

```sh
MCP_SERVER_URL=https://mcp.example.com \
PUBLIC_BASE_URL=http://127.0.0.1:3003 \
pnpm --filter @rgap/examples mcp-proxy
```

If the upstream server requires OAuth, open the authorization URL printed by
the app. The authorization server redirects the browser to:

```text
GET /oauth/callback
```

When `PUBLIC_BASE_URL` uses HTTPS, the app also publishes a Client ID Metadata
Document at `/oauth/client-metadata.json` and supplies its URL to the MCP SDK.
The SDK selects CIMD when the authorization server advertises support and
selects dynamic client registration when it advertises a registration
endpoint. HTTP loopback development uses dynamic registration because CIMD
client IDs require public HTTPS URLs.

The app writes an RGAP bearer to `invoker.token` and prints the executable
connection resource ID. Invoke any client-to-server request through that
resource:

```sh
TOKEN=$(<examples/mcp-proxy/invoker.token)

curl --no-buffer \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://localhost:3003/mcp/<connection-resource-id>
```

The response is an MCP JSON-RPC response. An MCP client first sends
`initialize`; the proxy handles lifecycle messages locally and forwards
ordinary request-response methods through the executable RGAP connection.

The example accepts one upstream URL from deployment configuration. A service
that accepts user-supplied URLs also validates redirects and resolved
addresses, blocks private and link-local destinations, and applies request
timeouts and response-size limits.

`credentials.db`, `oauth-flows.db`, `rgap.db`, the generated bearer, and the
default RGAP admin token are local-development conveniences. The SQLite
credential values are plaintext and must not be used as deployed secret
storage. A deployed proxy uses an encrypted credential store and an OAuth flow
store shared by every replica.
