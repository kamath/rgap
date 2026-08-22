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

- `domain.ts` defines resources, grants, tokens, executable definitions and immutable revisions, audit events, permission algebra, and pure resource/grant rules.
- `repository.ts` defines the ID-based `RgapCommands` adapter contract, `RgapStore`, `RgapRepository`, and resource/grant/token handles.
- `guard.ts` constructs the bearer-token command plane and enforces read visibility and command authority.
- `executable.ts` validates executable revisions, binding maps, schemas, and limits and orchestrates invocation.
- `runtime.ts` defines typed runtime results and invocations, normalized invocation events, opaque resource bindings, and the deployment-owned `RuntimeRegistry`.

A store exposes only `as(token)` and `admin()`. Both return the same repository interface. `repositoryFrom` turns an adapter's `RgapCommands` into handles. Resource handles expose executable reads, publishing, deletion, and streaming `invoke` in addition to tree operations. Equivalent top-level operations are available as `repository.executables` and `repository.invoke`.

Most methods are asynchronous request-response operations. Invocation is intentionally different: `invoke(resourceId, input)` and `resource.invoke(input)` return `AsyncIterable<InvocationEvent>`, where events are `data` or `done`. Runtime failures terminate that iterable instead of becoming events.

## Injected execution services

The SQLite store accepts deployment-owned services:

```ts
new SqliteRgapStore({
  url,
  runtimes,       // RuntimeRegistry or name -> InvokeRuntime
  validator,      // JsonSchemaValidator
  runtimeLimits,  // per-runtime host ceilings
});
```

The core package contains no built-in runtime implementation. A deployment registers heterogeneous trusted `InvokeRuntime<TProgram, TInput, TOutput>` implementations. Publishing calls that runtime's narrowing `validate(program)`, and invocation validates the program again. Each runtime returns a raw `TOutput`, a promise of one, or an `AsyncIterable<TOutput>`; registry type erasure remains internal.

## SQLite store

`@rgap/sqlite` exports `SqliteRgapStore`. Its constructor opens a file or `:memory:`, enables foreign keys, and applies the generated migrations in `drizzle/`. The schema adds executable definitions and immutable executable revisions to the resource, grant, capability, token, and audit tables.

| Table | Contents |
| --- | --- |
| `resources` | Stable resource records and tombstones. |
| `grants` | Grant identity, ancestry, expiration, and revocation. |
| `capabilities`, `capability_permissions` | Capability targets and normalized permission sets. |
| `tokens` | Token records and bearer hashes. |
| `executables` | Resource attachment, active revision, and deletion marker. |
| `executable_revisions` | Immutable runtime, program, schemas, binding schema, limits, and creation time. |
| `audit` | Ordered authorization, mutation, and invocation events. |

## Invocation lifecycle

The token plane authorizes `invoke` on the executable resource and every supplied binding. The orchestrator then:

1. Resolves the selected or active immutable revision.
2. Validates input when `inputSchema` is non-null, plus exact binding names, required bindings, and effective host ceilings.
3. Calls the registered runtime with an `AbortSignal`, immutable revision whose program has been narrowed, typed input, opaque `{ resourceId, kind }` bindings, and limits.
4. Awaits the result, turning a single value into one `data` event or an async iterable into one `data` event per item.
5. Validates every output value when `outputSchema` is non-null and emits `done` automatically.
6. Omits `data` for `undefined`, including yielded `undefined`, so void runtimes produce only `done` and HTTP streams stay JSON-compatible.
7. Records redacted invocation facts in a `finally` block as `done`, `error`, or `cancelled`.

Audit details include IDs, runtime, timing, and result. They exclude invocation input and output values. Cancelling iteration or the caller's signal aborts runtime work.

## HTTP server

`@rgap/server` maps every `RgapCommands` operation to one HTTP route. Executable operations use:

```text
GET    /resources/{id}/executable
GET    /resources/{id}/executable/revisions
GET    /executable-revisions/{id}
POST   /resources/{id}/executable/revisions
DELETE /resources/{id}/executable
POST   /resources/{id}/invoke
```

The invoke request is JSON `{ input, bindings?, revisionId? }`. A successful response is `application/x-ndjson`; each line is one serialized `data` or `done` event. Runtime throws and rejections fail the response stream. The server obtains the first event before committing the HTTP response, propagates request cancellation, and closes the runtime iterator when the client disconnects.

The other operations use JSON responses or `204`. `/openapi.json` and `/ui` describe the API. `HttpRgapStore` uses the generated SDK for JSON operations and a streaming fetch reader for invoke, parsing NDJSON back into the same async iterable contract.

## Scratchpad

`examples/index.ts` consumes the public store contracts as an external TypeScript caller does. It remains an editable exploration tool rather than runtime infrastructure.
