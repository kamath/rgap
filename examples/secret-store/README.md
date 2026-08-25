# Secret-store Hono app

This app demonstrates sealed resource bindings. An administrator creates a
GitHub credential resource, stores its value in `secrets.db` through
`@rgap/local-credential-store`, and binds it to a trusted `githubProfile`
executable.
A user receives `bind` on that safe function without receiving any permission
on its credential. The user then creates a `profile-summary` executable
resource that binds and invokes the safe function and delegates `invoke` on
that wrapper to a consumer.
Each resource create stores its executable and sealed bindings atomically.

Both bindings contain ordinary RGAP resource IDs:

```text
user-created profile-summary
└── profile → admin-created github-profile
              └── credential → github-token
```

Each binding records and revalidates its authorizing grant lineage at runtime.
Authority composes across the call chain: `profile-summary` can invoke
`github-profile`, whose own frame can use `github-token`. Authority is not
flattened into the outer frame, so the user cannot bind or read
`github-token`, even if its resource ID is known. Invocation input cannot
replace either sealed field.

The consumer needs only `invoke` on `profile-summary`. This deliberately
publishes the wrapper's narrow interface without delegating either binding.
Revoking the script author's lineage disables the wrapper's `profile` edge on
its next invocation.

Start the app:

```sh
pnpm --filter @rgap/examples secret-store
```

The app prints the user-created script resource ID and writes its bearer to
`script-invoker.token` with owner-only permissions. Invoke that resource:

```sh
TOKEN=$(<examples/secret-store/script-invoker.token)

curl --no-buffer \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"input":{}}' \
  http://localhost:3002/resources/<script-resource-id>/invoke
```

The response is an NDJSON stream whose data event contains
`"GitHub user: alice"`. It never contains the credential. The nested
`github-profile` invocation and the outer `profile-summary` invocation each
produce an audit record without inputs, outputs, or secret values.

Set `DEMO_SECRET` to choose the seeded value. Do not use the demo database,
generated bearer file, or default admin token in a deployed service.
