# RGAP: Hierarchical Capability Access

RGAP is an authorization model for filesystem-like resources, tools, and agent-accessible services. It supports hierarchical delegation, strict downscoping, fast revocation, and predictable access across resource moves and renames.

The model separates three concerns:

- **Resources** describe where objects live.
- **Grants** describe where authority comes from.
- **Tokens** are credentials used to exercise that authority.

Additional documents:

- [PROTOCOL.md](PROTOCOL.md) is the normative specification: records, permission algebra, delegation rules, and the decision procedure.
- [EXAMPLES.md](EXAMPLES.md) shows MCP server governance, tool aggregation, and sub-agent downscoping.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) defines the repository contract and SQLite implementation.
- [LANDSCAPE.md](LANDSCAPE.md) compares RGAP with existing capability, authorization, and agent-access systems.

## Core model

### Resources

Resources form a tree, like folders and files. Every resource has a stable ID; its path is only its current location.

A resource record contains only its stable ID, parent resource ID, name, and deletion marker. RGAP does not assign resource kinds such as organization, collection, server, folder, tool, or document. Applications may understand the objects referenced by resources, but that classification is not part of the resource hierarchy.

```text
projects/
└── alpha/
    ├── docs/
    │   └── design/
    └── secret
```

Renaming or moving a resource changes its position in the tree without changing its identity.

### Grants

A grant contains a set of capability entries. Each entry authorizes a set of operations over a resource and its subtree. The target is either a stable resource ID or a normalized path, distinguished by which field is present: `resourceId` names an object, `path` names a location. Both kinds share the same permission set. Multiple entries let one grant aggregate authority from several branches, such as tools exposed by different MCP servers. Grants may delegate authority to child grants.

```ts
type CapabilityConfig = {
  permissions: Permission[];
};

type ResourceCapability = CapabilityConfig & { resourceId: ResourceId };
type PathCapability = CapabilityConfig & { path: string };
type Capability = ResourceCapability | PathCapability;
```

An ID entry follows that resource and its subtree when they move. A path entry remains attached to that path when the resource there moves or is deleted, authorizes nothing while the path is empty, and applies when a resource later occupies the path, including that resource's subtree. Deleting an ID-targeted resource makes that entry permanently ineffective because resource IDs are never reused. In every case, other entries in the same grant continue to work.

A grant on a container therefore includes children that do not exist yet. Operators who do not want that expansion grant the leaves rather than the container. A grant on a leaf reaches only that resource until something is created under it.

A grant's identity, parent, and expiry are fixed when it is created. Its capability set is not: entries are set afterwards, and the set may be empty, in which case the grant authorizes nothing yet. Creating a grant and deciding what it reaches are separate acts, so a delegation can be recorded before its authority is chosen.

A child grant's parent must exist and be active. Creating or amending a grant under a missing, revoked, or expired parent throws `InvalidParentError`, which is an `RgapError`. A missing parent uses code `missing_parent`; a revoked or expired parent uses `inactive_parent`. Callers that care only that the parent is unusable catch `InvalidParentError`. Resource-parent refusals and a broken grant lineage stay ordinary `RgapError` values.

```text
Alice: read/write/delete projects/alpha
└── Bob: read projects/alpha/docs
    └── Carol: read projects/alpha/docs/design
```

Delegation may only downscope authority, entry by entry, as [PROTOCOL.md](PROTOCOL.md) defines. A child grant can have:

- Capability entries covered by entries in its parent
- A root at or within the covering parent entry's authorized subtree
- The same or fewer permissions for each entry
- The same or an earlier expiration time
- Constraints that are equal to or stricter than the covering parent entry

Bob therefore cannot grant write access or grant access outside `projects/alpha/docs`. The same proof is required whenever a grant's entries are set, not only when it is created, so an amended grant is bounded by its parent exactly as a new one is. Setting a grant's entries revokes any grant delegated from it whose own entries the new set no longer covers.

Every constraint type defines how one value contains another so the issuer can prove downscoping. For example, a child channel allowlist must be a subset of its parent's allowlist, and a child result limit must be less than or equal to its parent's limit.

### Tokens

Tokens are opaque bearer credentials that reference grants. Store only a cryptographic hash of each token.

Multiple tokens may reference one grant. Revoking a token disables only that credential; revoking a grant disables the grant and all grants delegated from it.

RGAP does not assign a subject identity to a grant. Possession of a valid bearer token is what permits use of the referenced grant. A host that authenticates people, services, or agents may associate its own identity records with grants or tokens outside the RGAP protocol.

### Identities

Resources, grants, and tokens each have their own identity. A grant's parent is a grant, a resource's parent is a resource, a capability ID target is a resource, `store.as` takes a bearer token, and a stored token record holds a hash of that bearer rather than the bearer itself. `@rgap/core` encodes those distinctions as branded strings:

| Type | Names |
| --- | --- |
| `ResourceId` | A resource's `id` and `parentId`, a capability's resource target, and `move`'s destination. |
| `GrantId` | A grant's `id` and `parentId`, and a token's `grantId`. |
| `TokenId` | A token record's `id`. |
| `TokenValue` | The bearer secret returned once by `grant.tokens.create`. `store.as`, `authorize`, and `inspectToken` take this value. |
| `TokenHash` | The hash stored on the token record. The bearer is never stored. |

A branded value is still a string at runtime. Records serialize as JSON strings and SQLite text, and [PROTOCOL.md](PROTOCOL.md) states the wire types as `string`. TypeScript does not treat the brands as interchangeable: `grant.create({ name: 'Drive read' })` cannot take a `ResourceId` parent, and `store.as(grant.id)` is a type error.

A path remains an ordinary string. Targeting `acme/drive` when the resource is named `acme-company` is a wrong location, not a wrong kind of identity, so it type-checks. Callers that want a stable object rather than a location use a `ResourceId` target.

The repository mints branded identities when it creates records and re-brands them when it reads stored state, so values that come from the repository are already typed. Seed data and tests that build records by hand use the exported constructors `resourceId`, `grantId`, `tokenId`, `tokenValue`, and `tokenHash`. An audit event's `target` is a `ResourceId`, `GrantId`, or `TokenId`, because an event concerns one of those records.

## Permissions

A capability entry carries a plain set of permissions:

| Permission | Authorizes |
| --- | --- |
| `read` | Reading the resource and listing its children. |
| `write` | Modifying what the resource refers to, and creating children under it. |
| `invoke` | Calling the resource, such as executing a tool. |
| `move` | Relocating the resource to a different parent. |
| `delete` | Deleting the resource together with its descendants. |

No permission implies another. `write` does not imply `read`, and `read` is not included by holding anything else. Implication would force delegation to compare closures rather than sets, which is where containment bugs hide, and it would make write-only authority — a drop box, an append-only sink — inexpressible. Callers that want familiar bundles offer presets when a grant is issued; the algebra underneath stays a set.

[PROTOCOL.md](PROTOCOL.md) states the authority each operation requires, so that independent implementations agree. Two rulings there are worth repeating here. A move requires `move` on the resource **and** `write` on the destination parent, because relocation changes who reaches the resource: without authority at the destination, a move would place a resource inside a scope the mover does not hold. Creating a root resource, creating a root grant, and moving a resource to a root are administrative operations; no token authorizes them.

## Enforcement boundary

RGAP stores expose no unrestricted command methods directly. A caller explicitly selects one of two command planes:

```ts
const repository = store.as(token);  // commands authorized by this bearer token
const admin = store.admin();         // unrestricted administrative commands
```

`store.as(token)` returns an `RgapRepository` whose commands check the authority required for each operation and refuse with the decision's explanation otherwise. `store.admin()` returns the same repository interface without token checks for trusted bootstrap and operational code. Handles obtained from either repository inherit that plane: `grant.tokens.create` on a guarded handle is the same authorized command as the repository would have run. The store object remains inside trusted infrastructure code; request handlers receive only the repository returned by `as(token)`, so forgetting an authorization wrapper cannot silently select the administrative plane.

The store does not authenticate the process allowed to call `admin()`. A host protects the store object with its module and process boundary and protects any remote administrative surface with infrastructure authentication. Administrative commands remain explicit and are recorded in the audit log.

`as(token)` guards commands and collection queries. Its resource queries return the resources the acting token reaches together with the ancestors needed to describe their paths. Its grant queries return the acting grant's lineage and delegated descendants. The administrative plane queries every record. `inspectToken(token)` reports the resources a presented token reaches and the permissions it holds on each. `authorize(token, resourceId, permission)` remains an explicit decision query about any presented token rather than inheriting the repository's command token.

## Security invariant

> Authority may only stay the same or become narrower as it is delegated; it can never expand.

Authorization checks the selected grant and every grant in its delegation ancestry against the requested live resource in the current tree. Each grant in the chain must contain a matching capability entry, so moving a target outside an ancestor's current scope makes the delegated authority ineffective without revoking the grant. Moving it back can make the authority effective again. If any ancestor is revoked, expired, or otherwise inactive, its descendants are inactive as well.

## Moves and renames

Moves and renames change the current resource tree without rewriting or revoking grants. Which field the entry carries determines what it means:

| Target | Behavior when a resource moves |
| --- | --- |
| `resourceId` | The entry follows the resource and its subtree. |
| `path` | The entry stays at the same path and applies to whatever live resource occupies it, including that resource's subtree. |

For example, suppose `secret` moves:

```text
projects/alpha/secret
        ↓
projects/private/secret
```

- An ID entry targeting `secret` follows it to `projects/private/secret`.
- A path entry targeting `projects/alpha/secret` stays there and authorizes nothing until that path is occupied again.
- A delegated entry is effective at the new location only when every grant in its lineage currently covers the requested resource there.

## Deletion

Deleting a resource does not revoke or rewrite grants. An ID entry targeting a deleted resource becomes permanently ineffective. A path entry remains attached to its normalized path, authorizes nothing while that path is empty, and applies to a different resource that later occupies the path. Entries targeting unaffected resources continue to authorize them.

Deletion marks the resource and its descendants as deleted rather than erasing their records. A deleted resource is gone for every purpose an application can observe: it appears in no listing, no path resolves to it, no command targets it, and no request is authorized against it. Its record is retained so that its stable ID is never reissued to a different resource, which keeps every revoked grant and audit event that references the ID resolvable to what it actually meant.

Because a retained record is identified by ID rather than by path, a deleted name is not reserved. A new resource may take a deleted resource's name under the same parent; it is a different resource and receives its own new stable ID.

## Atomic resource operations

A move or deletion commits the resource-tree change and its audit event atomically. Authorization always evaluates targets against one current tree snapshot, so a request never observes a partially moved or deleted subtree.

## Repository architecture

The repository contains four workspace packages:

- `@rgap/core` defines the protocol records, pure authorization rules, and store and repository contracts.
- `@rgap/sqlite` provides durable SQLite persistence.
- `@rgap/server` exposes the repository as a Hono HTTP API.
- `@rgap/examples` is an executable scratchpad for exploring the model.

`@rgap/core` contains the JSON-compatible domain records, pure RGAP rules, and asynchronous `RgapStore` and `RgapRepository` contracts. Identities in that TypeScript surface are branded (`ResourceId`, `GrantId`, `TokenId`, `TokenValue`, `TokenHash`); they serialize as ordinary strings. A store owns persistence and exposes only `as(token)` and `admin()` command-plane selection. `as` takes a `TokenValue`. Neither contract exposes a subscription or requires a streaming transport. The package has no dependency on a storage implementation or transport.

A repository is the request-response interface returned by `as` or `admin`. It exposes collections, looks up existing records, reads current state, and answers decision queries. Creating a grant or a resource is one command; the parent is an argument. TypeScript fills that argument from the receiver so the caller does not pass it.

A resource root comes from `resources.create`; a resource child comes from the parent handle. A grant's collection create mints the grant this plane may create: a root on the administrative plane, a child of the acting grant on a token plane. `grant.create` mints a child of that handle, and on a token plane that call is allowed only when the handle is the acting grant.

```ts
const acme = await admin.resources.create({ name: 'acme' });
const drive = await acme.create({ name: 'drive' });
const notes = await drive.create({ name: 'notes' });

const grant = await admin.grants.create({
  name: 'Acme admin', capabilities: [], expiresAt: null,
});
await grant.capabilities.set([
  { resourceId: acme.id, permissions: ['read', 'write'] },
]);
const issued = await grant.tokens.create({ label: 'cli' });
const alice = store.as(issued.value);
const reader = await alice.grants.create({
  name: 'Drive read', capabilities: [], expiresAt: null,
});
await reader.capabilities.set([
  { path: 'acme/drive', permissions: ['read'] },
]);
await issued.revoke();
await reader.revoke();

await notes.move(acme.id);
await notes.delete();
```

`resources.create` mints a root, which no token authorizes. `grants.create` mints a root on the administrative plane and a child of the acting grant on a token plane. `resource.create` and `grant.create` mint children of that handle. `grant.tokens.create` mints a token for that grant and returns the token handle together with the one-time bearer `value`. `resources.get(id)`, `grants.get(id)`, and `tokens.get(id)` return handles for records that already exist, and throw if the record is missing or, for a resource, deleted.

A handle carries the record's fields plus the collections and methods that act on it: a resource `create`s children, `move`s, and `delete`s; a grant `create`s child grants, `capabilities.set`s, `tokens.create`s, and `revoke`s; a token `revoke`s.

An HTTP adapter is the same commands as paths. Creating a grant or a resource is always one collection:

```text
POST /resources          { name, parentId }
POST /grants             { name, parentId, capabilities, expiresAt }
```

`parentId` is `null` for a root and the parent's id for a child. There is no `POST /grants/:id/grants` or `POST /resources/:id/resources`; those would be two routes for the same command. Nested paths are only for records that belong to another record, and for verbs:

```text
POST /grants/:id/tokens
PUT  /grants/:id/capabilities
POST /grants/:id/revoke
POST /resources/:id/move
DELETE /resources/:id
POST /tokens/:id/revoke
```

Repository reads use collection queries rather than returning the complete store:

```text
GET /resources/:id
GET /resources?parentId=…&cursor=…&limit=…
GET /grants/:id
GET /grants?parentId=…&cursor=…&limit=…
GET /tokens/:id
GET /tokens?grantId=…&cursor=…&limit=…
GET /audit?cursor=…&limit=…
```

Collection queries return an ordered array of plain serializable records directly, with no response envelope and no handles. Queries accept a bounded page size and an optional keyset cursor naming the last record from the previous page. A page shorter than the requested limit is complete; a full page may be followed by another request using its last record's ID as the cursor. A missing `parentId` or `grantId` filter does not turn a collection endpoint into an unbounded state dump; it returns one page in stable ID order. Query-side tree and path helpers consume these arrays directly, so callers use `await repository.resources.list(...)` without reading a `.records` property or reconstructing keyed state objects. Handles remain the TypeScript command surface, and a handle method that returns a record returns an updated handle.

`authorize` and `inspectToken` remain repository queries about a presented bearer rather than methods on a token handle, because the caller often has only the secret, not a stored record.

Every command addresses resources by `ResourceId`. A resource path describes only where a resource currently sits, so it is a presentation concern: `@rgap/core` exports the pure helpers that render a resource's path and resolve a path to an ID, and callers use them before they look up a handle or issue a command. Keeping resolution outside the boundary means a command can never act on whatever happens to occupy a path at the moment it arrives.

## HTTP API

`@rgap/server` is a Node.js Hono application in `apps/server`. It opens a `SqliteRgapStore` at the path in `RGAP_DATABASE_URL` and serves the repository operations described above. Every repository route requires an `Authorization: Bearer <token>` header and selects its command plane with `store.as(token)`. The HTTP application never exposes `store.admin()`; trusted bootstrap and operational code use the SQLite store directly.

The API includes the resource, grant, token, and audit collection routes listed above together with:

```text
POST /authorize       { token, resourceId, permission }
POST /tokens/inspect  { token }
GET  /openapi.json
```

`POST /authorize` and `POST /tokens/inspect` evaluate the bearer supplied in their JSON body while the authorization header controls access to the repository plane. Successful responses are the JSON-compatible `@rgap/core` records, arrays, decisions, and authority views. Commands that return no value respond with status `204`. Input validation failures use status `400`, an invalid or missing authorization bearer uses status `401`, an operation outside the selected plane uses status `403`, a missing record uses status `404`, and other domain conflicts use status `409`.

Each route is declared once with `@hono/zod-openapi`. Its Zod schemas validate path parameters, query parameters, headers, and JSON bodies at runtime and describe every success and error response. Hono derives the RPC `AppType` from the same chained route definitions, and the application publishes the generated OpenAPI document at `/openapi.json`.

The server package generates `openapi.json` from the application and runs HeyAPI against that document. HeyAPI writes a fetch-based TypeScript SDK and its model types to `apps/server/src/client/generated`. Generated files are never edited by hand. The route declarations are the source of truth for runtime behavior, the OpenAPI contract, the Hono RPC client, and the HeyAPI SDK, so both typed clients expose the same paths, inputs, statuses, and response bodies.

The package exports the Hono application, `AppType`, and generated HeyAPI client. `pnpm --filter @rgap/server generate` refreshes the OpenAPI document and SDK. The package build checks that generated output is current before type-checking, and its tests exercise validation, authorization-plane selection, OpenAPI generation, Hono RPC calls, and generated SDK calls against the in-process application.

## SQLite store

`@rgap/sqlite` implements `SqliteRgapStore` over a SQLite database with Drizzle ORM, so the model runs from ordinary TypeScript — a script, a test, or a service — against a real database. It runs on `better-sqlite3`, whose synchronous API is what lets a command read, decide, and write inside one transaction.

```ts
import { SqliteRgapStore } from '@rgap/sqlite';

const store = new SqliteRgapStore({ url: 'rgap.db' });
const admin = store.admin();

const acme = await admin.resources.create({ name: 'acme' });
const grant = await admin.grants.create({
  name: 'Acme admin', capabilities: [], expiresAt: null,
});
await grant.capabilities.set([
  { resourceId: acme.id, permissions: ['read', 'write'] },
]);

const { value } = await grant.tokens.create({ label: 'cli' });
const repository = store.as(value);
const acmeOnPlane = await repository.resources.get(acme.id);
const child = await acmeOnPlane.create({ name: 'notes' });
const decision = await repository.authorize(value, child.id, 'read');

store.close();
```

The constructor takes an optional `url`, a file path or `:memory:`, and an optional `initialState`, which is what an empty database is initialized with and what `reset()` restores. A database that already holds records is opened as it stands. `close()` releases the connection. Bearer values are returned once and never stored; the `tokens` table holds only hashes.

`admin()` and `as(token)` return the same `RgapRepository` interface, so callers cannot accidentally switch planes by changing command code. Only the explicit store selection differs.

### Schema

The store is normalized. Every record the protocol defines is a table, and every reference between records is a foreign key, so a state SQLite accepts is a state whose IDs all resolve.

| Table | Holds |
| --- | --- |
| `resources` | One row per resource: stable ID, parent ID, name, deletion marker. |
| `grants` | One row per grant: stable ID, name, parent grant ID, expiration, revocation. |
| `capabilities` | One row per capability entry, keyed by its grant and its position in that grant's set. |
| `capability_permissions` | One row per permission an entry carries, so a permission set is a relation SQL can query rather than an encoded value. |
| `tokens` | One row per issued token: stable ID, grant ID, label, hash, expiration, revocation. |
| `audit` | One row per recorded event, ordered by an explicit sequence number so the log's order is stored rather than inferred. |

Because an entry's permissions are a set, reading returns them in the protocol's canonical permission order rather than the order they were written in.

The schema is declared once as Drizzle tables, and `drizzle-kit` generates the DDL from that declaration. Opening a database applies the generated DDL, so a new file becomes a valid store and an existing one is left as it stands.

### Commands and transactions

A command is one SQLite transaction. It reads the complete state, applies the relevant pure `@rgap/core` rule, and replaces the stored rows with the state that rule returns. Nothing observes a partially updated authorization state, and a refused command writes nothing at all, because the rule rejects before the write begins.

Rows are written parents before children, so the foreign keys hold at every statement rather than only at the end of the transaction.

### Scratchpad

`examples/index.ts` is a scratchpad: ordinary TypeScript that opens a store, exercises whatever arrangement of resources, grants, and tokens is in question, and prints what the model decides. `pnpm scratch` runs it. It is a workspace package, so it imports `@rgap/sqlite` and `@rgap/core` the way any consumer does, and it is meant to be edited rather than preserved.

The file currently walks a five-step delegation. Resources are the company's workspace. Grants are who holds authority over it. Each step issues a token for the current grant, selects that token's plane with `store.as`, and creates a narrower child grant:

```text
acme/
├── platform/
│   ├── docs/
│   │   └── design
│   └── tools/
│       └── search
└── finance/
    └── payroll
```

```text
Company     acme, all permissions
└── Team    platform, read/write/invoke
    └── Employee    docs, read/write
        └── Agent   acme/platform/docs, read
            └── Subagent    acme/platform/docs/design, read
```

The company grant covers the whole tree. The team grant covers only `platform`, so `finance` is withheld from everyone below. Write stops at the employee. The agent and subagent use path targets rather than resource IDs. Authorization prints show what each token may still do.

It opens `examples/scratch.db` and resets it as it starts, so every run begins from the state the file declares and the database is left on disk afterwards to be read with any SQLite client. Removing the reset keeps what the previous run wrote.

The package's own suite runs against a `:memory:` database, so the tests exercise real SQL and real transactions rather than a stand-in.

## Testing

`@rgap/core` carries the RGAP rules, so its test suite covers all of it. The package measures coverage with Vitest's v8 provider and sets statement, branch, function, and line thresholds to 100 percent over `src`. `pnpm test` in the package runs the suite with coverage, so the threshold is a gate rather than a report, and the repository-wide `pnpm test` enforces it too. Coverage below the threshold fails the run.

The package is self-covering: everything the threshold measures is exercised by tests inside `@rgap/core`, so the gate never depends on a downstream package's suite. `domain.test.ts` covers the pure rules, which still take a state value and the record IDs those rules name. `guard.test.ts` covers the enforced path by wrapping a stub command sink that records the calls the guard forwards, including methods invoked on the handles that repository returns. The stub answers the guard's reads from a fixture state and returns a recorded result for each command, which isolates the guard's own decisions from any repository implementation.

Reaching every path means the suite asserts each rejection, not only each success: an invalid name, a duplicate ID or path, a missing parent, an expiration or capability that expands past a parent, and an amendment to a grant that is not active. It also asserts ID and path target behavior across moves, deletion, empty paths, and replacement resources, plus the structural guards. A cycle in the resource tree, a cycle in the grant tree, and a reference to a grant that does not exist are unreachable from the commands, because the commands maintain those properties; tests reach them by constructing such a state directly and calling the readers, which is what those guards exist to catch.

`fixture.ts` holds the shared fixture state and the stub command sink. It is test support rather than package surface, so the package entry point does not export it and coverage measurement excludes it along with the test files themselves.

## Example grant

```yaml
id: grant_bob_docs
parent_grant_id: grant_alice_alpha
capabilities:
  - path: projects/alpha/docs
    permissions: [read]
expires_at: 2026-12-31T23:59:59Z
revoked_at: null
```

## Design summary

```text
Resource tree = where things live
Grant tree    = where authority comes from
Token         = credential used to exercise a grant
```

Stable identities make renames and moves manageable. Strictly downscoped grants, proved at issue and again whenever entries are set, make delegated authority understandable. Hierarchical revocation allows an entire delegation branch to be disabled without updating every descendant individually.
