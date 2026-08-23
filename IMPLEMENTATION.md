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

- `domain.ts` defines resources, grants, tokens, executable associations, audit events, permission algebra, and pure resource/grant rules.
- `repository.ts` defines `RgapCommands`, `RgapStore`, `RgapRepository`, and resource/grant/token handles.
- `guard.ts` constructs the bearer-token command plane and enforces visibility and command authority.
- `executable.ts` atomically sets and deletes executable associations, validates bindings, and orchestrates invocation.
- `runtime.ts` defines structural runtime schemas, typed invocations and results, invocation events, opaque bindings, and `RuntimeRegistry`.

A resource handle exposes `executable.get`, `executable.set({ runtime })`, `executable.delete`, and streaming `invoke`. Equivalent top-level methods are available through `repository.executables` and `repository.invoke`.

Invocation returns `AsyncIterable<InvocationEvent>`, where events are `data` or `done`. Runtime failures terminate the iterable instead of becoming events.

## Deployment-owned runtimes

The SQLite store accepts only deployment-owned runtime configuration:

```ts
new SqliteRgapStore({
  url,
  runtimes, // RuntimeRegistry or name -> InvokeRuntime
});
```

Each heterogeneous `InvokeRuntime<TInput, TOutput>` owns nullable structural input and output schemas, optional binding declarations, and its invoke implementation. The schemas expose `parse(value: unknown)`, so Zod schemas work directly without a core dependency on Zod. Runtime registration and behavior are not repository state.

## SQLite store

`@rgap/sqlite` opens a file or `:memory:`, enables foreign keys, and applies generated migrations. Its normalized tables are:

| Table | Contents |
| --- | --- |
| `resources` | Stable resource records and tombstones. |
| `grants` | Grant identity, ancestry, expiration, and revocation. |
| `capabilities`, `capability_permissions` | Capability targets and normalized permission sets. |
| `tokens` | Token records and bearer hashes. |
| `executables` | One row per association, keyed by `resource_id`, with only `runtime`. |
| `audit` | Ordered authorization, mutation, and invocation events. |

`setExecutable` verifies that the resource is live and the runtime is registered, then atomically upserts the association and audit event. `deleteExecutable` removes the row and records the deletion. No executable tombstone or revision table exists.

## Invocation lifecycle

The token plane authorizes `invoke` on the executable resource and every supplied binding. The orchestrator then:

1. Resolves the executable association and registered runtime.
2. Parses input when `inputSchema` is non-null.
3. Rejects undeclared bindings and missing required bindings from the runtime declaration.
4. Calls the runtime with typed input, an `AbortSignal`, and opaque `{ resourceId, kind }` bindings.
5. Normalizes a single value, promise, async iterable, or `undefined`.
6. Parses every output when `outputSchema` is non-null, emits `data`, and emits `done` automatically.
7. Records redacted invocation facts as `done`, `error`, or `cancelled` in a `finally` block.

The audit detail contains resource ID, runtime, grant-lineage IDs, binding resource IDs, timing, and result. It excludes invocation input and output values. Caller cancellation and early iterator return abort runtime work.

## HTTP server

The server maps executable commands one-to-one:

```text
GET    /resources/{id}/executable
PUT    /resources/{id}/executable     { runtime }
DELETE /resources/{id}/executable
POST   /resources/{id}/invoke         { input, bindings? }
```

Invoke responds as `application/x-ndjson`, with one serialized `data` or `done` event per line. Runtime failures fail the response stream. The server obtains the first event before committing the response, propagates request cancellation, and closes the runtime iterator when the client disconnects.

The route declarations generate OpenAPI and the HeyAPI SDK. `HttpRgapStore` uses generated methods for JSON operations and a streaming fetch reader for invocation. The generated surface contains only the current association and invocation operations.

## Scratchpad

`examples/index.ts` configures an echo runtime with Zod input/output schemas and a binding declaration directly on the runtime. It associates the runtime with `search.executable.set({ runtime: 'echo' })` and invokes it through the ordinary repository plane.
