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
app.route('/rgap', createRgapApp({ store, adminToken }));
```

`createMcpProxyApp` exposes `POST /mcp/:connectionId`,
`GET /oauth/callback`, and `GET /oauth/client-metadata.json`, relative to its
mount point. It does not mount the RGAP API. The MCP route uses the request
bearer and supplied store to invoke the selected connection through RGAP.
`publicBaseUrl` is the externally visible URL of that mount point. For the
example above it is `https://example.com/integrations/mcp`.
The configured public URL and Hono mount path must match.

The host mounts `@rgap/server` separately when it wants generic resource
management. Both route groups share the store, but MCP requests call RGAP
directly instead of making HTTP requests to `/rgap`.

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
the `CredentialStore` interface from `@rgap/credential-store-sqlite`. This
example uses `SqliteCredentialStore` to keep them in `credentials.db` under the
credential resource ID. The browser callback validates state and expiry before
asking the MCP SDK to validate the issuer and exchange the authorization code.

`@rgap/oauth-flow-store-sqlite` provides the callback lookup store interface and
`SqliteOAuthFlowStore`. It keys pending callback records by a SHA-256 hash of
state in `oauth-flows.db`. Claiming one is atomic and one-time. A replicated
deployment sets `RGAP_POSTGRES_URL` to use
`@rgap/credential-store-postgres`, `@rgap/oauth-flow-store-postgres`, and
`@rgap/store-postgres` for shared state.

Start the proxy:

```sh
MCP_SERVER_URL=https://server.smithery.ai/gmail \
PUBLIC_BASE_URL=http://127.0.0.1:3003 \
pnpm --filter @rgap/examples mcp-proxy
```

To run every store against PostgreSQL:

```sh
RGAP_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/rgap \
MCP_SERVER_URL=https://server.smithery.ai/gmail \
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

After the browser displays `MCP authorization complete`, leave the gateway
running. It writes an RGAP bearer to `invoker.token` and prints the executable
connection resource ID.

Run the executable client example against that gateway:

```sh
RGAP_TOKEN="$(<examples/mcp-proxy/invoker.token)" \
MCP_CONNECTION_ID=<connection-resource-id> \
pnpm --filter @rgap/examples exec tsx mcp-proxy/client.ts
```

The client example uses the helper this way:

```ts
const client = await createMcpProxyClient({
  proxyUrl: new URL(process.env.MCP_PROXY_URL ?? 'http://localhost:3003'),
  connectionId,
  rgapToken,
  clientInfo: {
    name: 'example',
    version: '0.0.0',
  },
});
const tools = await client.request(
  { method: 'tools/list', params: {} },
  z.unknown(),
);
```

`createMcpProxyClient` comes from the separate `@rgap/mcp-proxy-client`
example-support package. It attaches the bearer and sends `initialize` before
returning the client. The proxy handles lifecycle messages locally and forwards
ordinary request-response methods through the executable RGAP connection.
The example prints the upstream `tools/list` result and closes the client.

The example accepts one upstream URL from deployment configuration. A service
that accepts user-supplied URLs also validates redirects and resolved
addresses, blocks private and link-local destinations, and applies request
timeouts and response-size limits.

`credentials.db`, `oauth-flows.db`, `rgap.db`, the generated bearer, and the
default RGAP admin token are local-development conveniences. The SQLite
credential values are plaintext and must not be used as deployed secret
storage. The PostgreSQL credential adapter also stores the JSON value it
receives without adding encryption. A deployed proxy encrypts credential values
before persistence or supplies an equivalent database encryption boundary.
