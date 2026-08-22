# Repository Implementation

The repository implements RGAP as framework-neutral TypeScript rules, a SQLite store, a Hono HTTP server and client, and an executable scratchpad:

```text
packages/core/       # records, authorization, executable orchestration, runtimes, and contracts
packages/sqlite/     # Drizzle schema and SQLite implementation
apps/server/         # Hono JSON/NDJSON API and HttpRgapStore
examples/            # editable scratchpad
```

## Core boundary

`@rgap/core` separates five modules:

- `domain.ts` defines resources, grants, tokens, executable definitions and immutable revisions, public secret and runtime-private metadata, audit events, permission algebra, and pure resource/grant rules.
- `repository.ts` defines the ID-based `RgapCommands` adapter contract, `RgapStore`, `RgapRepository`, and resource/grant/token handles.
- `guard.ts` constructs the bearer-token command plane and enforces read visibility and command authority.
- `executable.ts` validates executable revisions, binding maps, schemas, and limits and orchestrates invocation.
- `runtime.ts` defines invocation events, opaque protected-value handles, injected host contracts, and the deployment-owned `RuntimeRegistry`.

A store exposes only `as(token)` and `admin()`. Both return the same repository interface. `repositoryFrom` turns an adapter's `RgapCommands` into handles. Resource handles expose `executable.publish`, `secret.write`, `runtimePrivateMetadata`, and streaming `invoke` in addition to tree operations. Equivalent top-level collections are available as `repository.executables`, `repository.secrets`, and `repository.invoke`.

Most methods are asynchronous request-response operations. Invocation is intentionally different: `invoke(resourceId, input)` and `resource.invoke(input)` return `AsyncIterable<InvocationEvent>`, where events are `data`, `error`, or `done`.

## Injected execution services

The SQLite store accepts deployment-owned services:

```ts
new SqliteRgapStore({
  url,
  runtimes,       // RuntimeRegistry or name -> InvokeRuntime
  validator,      // JsonSchemaValidator
  runtimeLimits,  // per-runtime host ceilings
  secrets,        // SecretStore
  credentials,    // RuntimeCredentialStore
});
```

The core package contains no built-in fetch, GitHub, OpenAI, or other provider runtime. A deployment registers trusted `InvokeRuntime` implementations. Publishing calls that runtime's `validate(program)`, and invocation validates the program again.

`SecretStore` and `RuntimeCredentialStore` keep protected values outside repository state. SQLite stores only `SecretMetadata` and runtime-scoped `RuntimePrivateMetadata`. Runtime code receives opaque handles and a slot-scoped private-state interface; repository and HTTP reads never return a protected value.

## SQLite store

`@rgap/sqlite` exports `SqliteRgapStore`. Its constructor opens a file or `:memory:`, enables foreign keys, and applies the generated migrations in `drizzle/`. The current migration adds executable definitions, immutable executable revisions, secret metadata, and runtime-private metadata to the existing resource, grant, capability, token, and audit schema.

| Table | Contents |
| --- | --- |
| `resources` | Stable resource records and tombstones. |
| `grants` | Grant identity, ancestry, expiration, and revocation. |
| `capabilities`, `capability_permissions` | Capability targets and normalized permission sets, including `use`. |
| `tokens` | Token records and bearer hashes. |
| `executables` | Resource attachment, active revision, and deletion marker. |
| `executable_revisions` | Immutable runtime, program, schemas, binding schema, limits, and creation time. |
| `secret_metadata` | Public version and update time for externally stored secrets. |
| `runtime_private_metadata` | Public version and update time keyed by runtime and resource. |
| `audit` | Ordered authorization, mutation, and invocation events. |

Metadata transitions use the same whole-state SQLite transaction mechanism as the rest of the store. A protected-value write or delete completes in the injected external store before SQLite commits its public metadata. Reset makes best-effort external deletions and then restores the configured initial state.

## Invocation lifecycle

The token plane authorizes `invoke` on the executable resource, `use` on every supplied binding, and also `write` for each binding whose declared access is `write`. The orchestrator then:

1. Resolves the selected or active immutable revision.
2. Validates input, exact binding names, required bindings, and effective host ceilings.
3. Resolves opaque secret and runtime-private handles only after authorization.
4. Calls the registered runtime with an `AbortSignal`, immutable revision, input, bindings, limits, and slot-scoped credential state.
5. Validates each `data` event against the output schema when one exists.
6. Records redacted invocation facts in a `finally` block as `done`, `error`, or `cancelled`.

Audit details include IDs, runtime, timing, and result. They exclude invocation input, output values, secret material, credential material, and handles. Cancelling iteration or the caller's signal aborts runtime work.

## HTTP server

`@rgap/server` maps every `RgapCommands` operation to one HTTP route. Executable operations use:

```text
GET    /resources/{id}/executable
GET    /resources/{id}/executable/revisions
GET    /executable-revisions/{id}
POST   /resources/{id}/executable/revisions
DELETE /resources/{id}/executable
GET    /resources/{id}/secret
PUT    /resources/{id}/secret
DELETE /resources/{id}/secret
GET    /resources/{id}/runtime-private/{runtime}
POST   /resources/{id}/invoke
```

The invoke request is JSON `{ input, bindings?, revisionId? }`. A successful response is `application/x-ndjson`; each line is one serialized `InvocationEvent`. The server obtains the first event before committing the HTTP response, propagates request cancellation, and closes the runtime iterator when the client disconnects.

The other operations use JSON responses or `204`. `/openapi.json` and `/ui` describe the API. `HttpRgapStore` uses the generated SDK for JSON operations and a streaming fetch reader for invoke, parsing NDJSON back into the same async iterable contract.

## Scratchpad

`examples/index.ts` consumes the public store contracts as an external TypeScript caller does. It remains an editable exploration tool rather than runtime infrastructure.
