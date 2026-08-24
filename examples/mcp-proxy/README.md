# MCP proxy Hono app

This app is an OAuth-compatible MCP client. It registers one RGAP resource for
an MCP server and invokes that resource with MCP JSON-RPC. OAuth access tokens
stay in a deployment-owned secret store. The browser redirect completes
authorization by invoking a sealed callback resource.

Default mode hosts a mock authorization server and MCP `echo` tool so the
loop runs without an external provider. Set `MCP_SERVER_URL` to target any
remote MCP server that speaks protected-resource metadata, PKCE, and
dynamic client registration.

Start the app:

```sh
pnpm --filter @rgap/examples mcp-proxy
```

The app prints the authorize and RPC resource IDs and writes a consumer
bearer to `consumer.token`. Start OAuth:

```sh
TOKEN=$(<examples/mcp-proxy/consumer.token)

curl --no-buffer \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"input":{}}' \
  http://127.0.0.1:3003/resources/<authorize-resource-id>/invoke
```

Open the returned `authorizationUrl` (or `curl -L` it against the mock). The
authorization server redirects to `/oauth/callback`, which invokes the
callback resource and stores tokens. Then call the server:

```sh
curl --no-buffer \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"input":{"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}}}}' \
  http://127.0.0.1:3003/resources/<rpc-resource-id>/invoke
```

The consumer has `invoke` on authorize and RPC only. It has no permission on
the credential or callback resources. The callback HTTP route uses a
deployment grant that can invoke only the callback resource.

Set `MCP_PROXY_BASE_URL` when the OAuth redirect URI must be a public origin.
Do not use the demo database, generated bearer file, or default admin token in
a deployed service.
