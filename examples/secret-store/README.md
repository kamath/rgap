# Secret-store Hono app

This app exposes a generic `reveal-secret` runtime through the RGAP Hono API.
It keeps authorization state in `rgap.db` and secret values in `secrets.db`.
`SecretStore` defines the storage interface, and `SqliteSecretStore` is the
default implementation initialized by `index.ts`. The secret database indexes
each value by its stable RGAP resource ID.

Start the app:

```sh
pnpm --filter @rgap/examples secret-store
```

The app prints the reveal resource ID and secret binding ID. It writes a
demo bearer to `secret-reader.token` with owner-only permissions. Invoke the
reveal resource with those IDs:

```sh
TOKEN=$(<examples/secret-store/secret-reader.token)

curl --no-buffer \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"input":null,"bindings":{"secret":"<secret-binding-id>"}}' \
  http://localhost:3002/resources/<reveal-resource-id>/invoke
```

RGAP checks `invoke` on the reveal executable and on the bound secret resource
before the runtime reads `secrets.db`. The response is an NDJSON stream whose
data event contains the secret string.

Set `DEMO_SECRET` to choose the seeded value. Do not use the demo database,
generated bearer file, or default admin token in a deployed service.
