# OAuth MCP proxy

This Hono app represents a remote Streamable HTTP MCP server as an executable
RGAP connection. The server definition, authenticated connection, and
credential are separate resources:

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
pending callback state are stored through `@rgap/local-credential-store` in
`credentials.db` under the credential resource ID. The browser callback
validates state and expiry before asking the MCP SDK to validate the issuer and
exchange the authorization code.

Pending callback lookup records are keyed by a SHA-256 hash of state in
`oauth-flows.db`. Claiming one is atomic and one-time.

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
  --data '{"input":{"method":"tools/list"}}' \
  http://localhost:3003/resources/<connection-resource-id>/invoke
```

The response is an NDJSON stream containing the upstream MCP result followed
by a `done` event. `initialize` and `server/discover` remain owned by the MCP
SDK and are not caller-controlled.

The example accepts one upstream URL from deployment configuration. A service
that accepts user-supplied URLs also validates redirects and resolved
addresses, blocks private and link-local destinations, and applies request
timeouts and response-size limits.

`credentials.db`, `oauth-flows.db`, `rgap.db`, the generated bearer, and the
default RGAP admin token are local-development conveniences. The SQLite
credential values are plaintext and must not be used as deployed secret
storage.
