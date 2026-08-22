# RGAP Protocol

This document is the normative definition of RGAP: the records, the permission algebra, the delegation rules, and the decision procedure. [README.md](README.md) explains the model and its intent, [IMPLEMENTATION.md](IMPLEMENTATION.md) describes the reference packages, and this document defines what any implementation must compute.

Authorization and metadata transitions are expressed over one immutable state value. An implementation conforms when, given the same state and request, it reaches the same decision. Invocation additionally depends on the same deployment-owned runtime registry, validator, limit ceilings, secret store, and credential store.

## Records

State is seven normalized collections plus an ordered audit log.

```ts
type State = {
  resources: Record<string, Resource>;
  grants: Record<string, Grant>;
  tokens: Record<string, Token>;
  executables: Record<string, ExecutableDefinition>;                 // keyed by resource ID
  executableRevisions: Record<string, ExecutableRevision>;
  secretMetadata: Record<string, SecretMetadata>;                    // keyed by resource ID
  runtimePrivateMetadata: Record<string, RuntimePrivateMetadata>;    // keyed by runtime and resource
  audit: AuditEvent[];
};
```

```ts
type Resource = {
  id: string;                                        // stable identity, assigned once
  parentId: string | null;                           // null for a root
  name: string;                                      // unique among live siblings, contains no separator
  deletedAt: string | null;                          // tombstone marker
};

type CapabilityConfig = {
  permissions: Permission[];                         // a set; order is not significant
};

type ResourceCapability = CapabilityConfig & { resourceId: string };  // follows one stable resource identity
type PathCapability = CapabilityConfig & { path: string };            // stays attached to one normalized location
type Capability = ResourceCapability | PathCapability;

type Grant = {
  id: string;
  name: string;
  parentId: string | null;                           // null for a root grant
  capabilities: Capability[];                        // a set; may be empty, which authorizes nothing
  expiresAt: string | null;                          // null never expires
  revokedAt: string | null;
};

type Token = {
  id: string;
  grantId: string;
  label: string;
  hash: string;                                      // hash of the bearer value; the value is never stored
  expiresAt: string | null;
  revokedAt: string | null;
};

type BindingSlot = {
  kind: 'resource' | 'secret' | 'runtime-private';
  access: 'use' | 'write';
  required?: boolean;                                // required unless explicitly false
};

type ExecutionLimits = {
  timeoutMs?: number;
  memoryBytes?: number;
  outputBytes?: number;
  concurrency?: number;
  network?: { allowedOrigins: string[] };
};

type ExecutableDefinition = {
  resourceId: string;
  activeRevisionId: string | null;
  deletedAt: string | null;
};

type ExecutableRevision = {
  id: string;
  resourceId: string;
  runtime: string;
  program: unknown;
  inputSchema: boolean | Record<string, unknown>;
  outputSchema: boolean | Record<string, unknown> | null;
  bindingSchema: Record<string, BindingSlot>;
  limits: ExecutionLimits;
  createdAt: string;
};

type SecretMetadata = {
  resourceId: string;
  version: string;
  updatedAt: string;
};

type RuntimePrivateMetadata = {
  runtime: string;
  resourceId: string;
  version: string;
  updatedAt: string;
};

type AuditEvent = {
  id: string;
  at: string;                                        // RFC 3339 timestamp
  action: string;
  target: string;                                    // the stable ID the event concerns
  result: 'allowed' | 'denied' | 'recorded';
  detail: string;
};
```

`Permission` is `'read' | 'write' | 'use' | 'invoke' | 'move' | 'delete'`.

Every persisted record is JSON-compatible. Executable programs and schemas are JSON-compatible values. Timestamps are RFC 3339 strings compared lexicographically, which requires them to be UTC with a fixed number of fractional digits. Secret and runtime-private metadata are public records; the protected values and credentials they describe are not protocol state.

## Identity and location

A resource's `id` is its identity and never changes. Nothing in the protocol writes `id` after creation, and no operation renames one resource into another's identity.

A resource's path is derived, not stored: the names of its ancestors and itself joined by `/`.

```ts
resourcePath(resources, id) =
  [...ancestors(id), id].map((each) => resources[each].name).join('/')
```

Paths are canonicalized by splitting on `/`, trimming each segment, and discarding empty segments. `Acme`, `Acme/`, and `/Acme//` are the same path. The root is not a resource, so the empty path names nothing.

```ts
resourceIdAtPath(resources, path) -> string | null      // null when nothing live is at that path
requireResourceId(resources, path) -> string            // raises missing_resource instead of returning null
```

Resource commands name resources by stable ID, so a caller resolves an operational path at the moment it reads state. Capability path targets are different: the normalized path is stored as part of the grant and resolved from the current tree for every authorization decision.

An ID entry names an identity. It follows the resource and its subtree when they move. A path entry names a location. It remains attached to the same normalized path while empty and applies to a resource that later occupies that path, including that resource's subtree. Every entry covers its target and the live resources currently under it.

### Ancestry

```ts
isWithin(resources, id, rootId) =
  id === rootId || (parentId(id) !== null && isWithin(resources, parentId(id), rootId))
```

`isWithin` is reflexive: a resource is within itself. An implementation detects a cycle while walking parents and raises `resource_cycle`; the operations below never create one.

### Tombstones

Deletion marks `deletedAt` on a resource and its live descendants. The records are retained, and a resource with `deletedAt` set is *not live*.

```ts
isLive(resource) = resource !== undefined && resource.deletedAt === null
```

Every read skips resources that are not live: path resolution, listings, capability validation, authorization, and the authority view. Two consequences are load-bearing:

- A stable ID is never reissued, because the retained record still occupies it. A capability or audit event that names a deleted ID still names exactly what it always named.
- A name is released, because uniqueness among siblings is checked against live resources only. A new resource may take a deleted resource's name under the same parent; it is a different resource with its own new ID.

`resourcePath` continues to resolve for a tombstone, so an ID-targeted capability can still report the path its resource held.

## Permissions

| Permission | Authorizes |
| --- | --- |
| `read` | Reading the resource and listing its children. |
| `write` | Modifying what the resource refers to, and creating children under it. |
| `use` | Supplying the resource as an opaque invocation binding without reading its protected value. |
| `invoke` | Calling the resource, such as executing a tool. |
| `move` | Relocating the resource to a different parent. |
| `delete` | Deleting the resource together with its descendants. |

**No permission implies another.** Permissions form a plain set, compared by subset. `write` does not imply `read`, and no permission is granted by holding another. Implication would require delegation to compare closures rather than sets, and it would make write-only authority inexpressible. Implementations that want familiar bundles apply presets when a grant is issued; the algebra underneath stays a set.

Each operation requires this authority:

| Operation | Required authority |
| --- | --- |
| Read a resource, list its children | `read` on the resource |
| Invoke a resource | `invoke` on the resource |
| Bind a resource to an invocation | `use` on the bound resource, plus `write` when the slot access is `write` |
| Read executable revisions or protected-value metadata | `read` on the resource |
| Publish or delete an executable; write or delete a secret | `write` on the resource |
| Create a child resource | `write` on the intended parent |
| Move a resource | `move` on the resource **and** `write` on the destination parent |
| Delete a resource and its descendants | `delete` on the resource |
| Delegate a child grant | The delegating grant is the grant the token references, and the child downscopes it |
| Set a grant's capabilities | The grant is delegated from the acting token's grant, and the new set downscopes the grant's parent |
| Issue or revoke a token | The token's grant is the acting token's grant or a grant delegated from it |
| Revoke a grant | The grant is the acting token's own grant or one delegated from it |

A move requires authority at both ends because relocation changes who reaches the resource. Without `write` on the destination, a move would place a resource inside a scope the mover does not hold.

Creating a root resource, moving a resource to a root, creating a root grant, and setting a root grant's capabilities are administrative operations. No token authorizes them, because there is no resource or grant above them to derive authority from.

## Capability algebra

Two relations define everything else: what a capability authorizes, and when one capability contains another.

### Authorization by a single entry

```ts
targetResourceId(capability, resources) =
  'path' in capability
    ? resourceIdAtPath(resources, capability.path)
    : (isLive(resources[capability.resourceId]) ? capability.resourceId : null)

authorizes(capability, resources, resourceId, permission) =
  capability.permissions.includes(permission) &&
  targetResourceId(capability, resources) !== null &&
  isWithin(resources, resourceId, targetResourceId(capability, resources))
```

### Containment

`covers(parent, child)` holds when every request the child entry authorizes is also authorized by the parent entry.

```ts
covers(parent, child, resources) =
  location(parent, child, resources) &&
  child.permissions.every((permission) => parent.permissions.includes(permission));

location(parent, child, resources) = {
  if both entries name a path:
    child.path is equal to or lexically beneath parent.path
  otherwise:
    let parentId = targetResourceId(parent, resources)
    let childId = targetResourceId(child, resources)
    parentId !== null && childId !== null && isWithin(resources, childId, parentId)
}
```

Each clause is a containment proof over one dimension:

- **Location.** Two path entries compare lexically, which permits an empty child path to be delegated beneath a parent path. Every comparison involving an ID resolves both entries against the current live tree. An entry covers its target and everything currently under it.
- **Permissions.** The child's set is a subset of the parent's.

Containment is required when a grant is issued or amended. Authorization separately checks every grant in the lineage against the requested resource in the current tree. Moving a target can therefore make delegated authority ineffective or effective again, but it cannot widen authority beyond what every ancestor currently authorizes.

## Grants

### Validity at issue

A grant is created only when all of the following hold:

1. `name` is non-empty.
2. Every entry in `capabilities` has at least one permission and names exactly one of `resourceId` or `path`. A `resourceId` names a live resource. A `path` has a non-empty normalized path and need not currently resolve. The set may be empty, in which case the grant authorizes nothing until its capabilities are set.
3. If `parentId` is set, the parent grant exists and is active. A missing or inactive parent is `InvalidParentError` (`missing_parent` or `inactive_parent`).
4. If the parent has an `expiresAt`, the child has one and it is no later than the parent's.
5. Every child capability entry is covered by at least one parent capability entry, by `covers` above.

Rules 4 and 5 are the downscoping proof. A root grant, having no parent, is unconstrained by them and is therefore administrative.

### Setting capabilities

A grant's identity, parent, and expiry are fixed at issue. Its capability set is not: `setCapabilities(state, grantId, capabilities, at)` replaces the whole set in one atomic transition.

1. The grant exists and is active. A revoked or expired grant is not amended.
2. Every entry has at least one permission and names exactly one of `resourceId` or `path`. Resource IDs name live resources, and paths hold non-empty normalized locations that may be empty.
3. If the grant has a parent, every entry is covered by at least one entry of the parent grant, by `covers` above. A root grant's entries are unconstrained, so setting them is administrative.
4. Let `orphaned` be the active grants delegated directly from this grant that hold an entry which no entry of the new set covers.
5. Revoke each grant in `orphaned` together with everything delegated from it.
6. Commit the normalized capability set, the revocations, and the audit event together.

Rule 3 is the same downscoping proof as issue, applied at the moment the set changes, so an amended grant is bounded by its parent exactly as a newly issued one is. Rule 4 need only consider direct children: a deeper grant is covered against its own parent, which this operation does not change. A child is orphaned when the parent gives up its target or permission coverage.

Resource IDs name live resources when set but remain stored if their resources are later deleted. Paths may be unresolved from the start. Neither condition invalidates or revokes the grant; the affected entry simply authorizes no live resource.

Narrowing a set takes effect on the next decision whether or not rule 5 runs, because `authorize` re-checks coverage against every grant in the lineage. Rule 5 exists so the consequence is a recorded revocation rather than a grant record that remains active while authorizing nothing.

### Activity

```ts
isActive(record, now) = record.revokedAt === null && (record.expiresAt === null || record.expiresAt > now)
```

Expiry is exclusive: a record whose `expiresAt` equals `now` is no longer active. The same predicate applies to grants and tokens.

### Lineage

```ts
lineage(grants, grantId) = [grants[grantId], ...lineage(grants, grants[grantId].parentId)]
```

The lineage runs from the grant itself to its root grant. A missing ancestor is `missing_parent`; a repeated one is `grant_cycle`.

### Revocation

Revoking a grant sets `revokedAt` on that grant and transitively on every grant delegated from it, leaving an already-revoked timestamp unchanged. Records are retained; revocation is a state, not a deletion.

Revoking a token sets `revokedAt` on that token only. Other tokens on the same grant remain usable.

## Tokens

A token is an opaque bearer string. Only its hash is stored, and a request is matched by hashing the presented value and comparing. The reference implementation uses SHA-256 rendered as lowercase hex; any preimage-resistant hash conforms as long as one implementation uses one hash.

A token's `expiresAt` is set at issue and does not exceed the expiry of the grant it references. A token grants no authority of its own: it names a grant, and the grant's lineage determines what it can do.

## Decision procedure

`authorize(state, tokenHash, resourceId, permission, now)` returns a decision.

```ts
type Decision = {
  allowed: boolean;
  detail: string;                 // the reason, in either outcome
  grantId: string | null;         // the grant the token references
  lineage: string[];              // the grant chain that was checked
};
```

The procedure:

1. If `resources[resourceId]` is not live, deny. The resource does not exist.
2. Find the token whose `hash` equals `tokenHash`. If there is none, or it is not active, deny.
3. Compute `chain = lineage(grants, token.grantId)`. If any grant in the chain is not active, deny; a revoked or expired ancestor disables everything beneath it.
4. For every grant in the chain, find whether at least one of its entries satisfies `authorizes(entry, resources, resourceId, permission)`.
5. Allow only when every grant has such an entry:

```ts
allowed = chain.every((grant) =>
  grant.capabilities.some((entry) =>
    authorizes(entry, resources, resourceId, permission)));
```

Step 5 is the security invariant made executable. Authority is the intersection of the whole chain in the current tree. Entries at different levels need not use the same target type, but every level must currently authorize the concrete requested resource.

A decision is a pure function of state. Recording an audit event for the decision is a separate, additive state change.

### Authority view

`inspectToken(state, tokenHash, now)` reports what a token reaches.

```ts
type AuthorityView = {
  valid: boolean;
  detail: string;
  grantId: string | null;
  lineage: string[];
  permissions: Record<string, Permission[]>;   // live resource ID -> permissions held
};
```

It is defined by the decision procedure: for every live resource, the permissions for which `authorize` allows. An invalid, expired, or revoked token, or one whose chain contains an inactive grant, yields no permissions and a `detail` explaining why.

## Resource operations

Each operation is one atomic state transition. It reads one snapshot, computes the complete next state and its audit event, and commits once. A request never observes a partially updated resource tree.

### Create

Requires a non-empty name containing no `/`, a live parent when `parentId` is set, an unused ID, and no live sibling of the same name under that parent. The new resource is live.

### Move

`move(state, id, parentId, at)`:

1. The resource is live, and the destination parent is live or `null`.
2. The destination is neither the resource itself nor within its subtree, which would create a cycle.
3. Reparent the resource.
4. Commit the reparenting and audit event together.

Moves and renames do not rewrite or revoke grants. ID targets follow their resources. Path targets remain attached to their normalized locations. The next authorization decision evaluates every target against the new tree.

### Delete

`delete(state, id, at)`:

1. The resource is live.
2. Let `removed` be the live resources within its subtree.
3. Mark every resource in `removed` with `deletedAt`.
4. Commit the tombstones and audit event together.

Deletion does not rewrite or revoke grants. ID targets naming removed resources become permanently ineffective because IDs are not reused. Path targets become ineffective while empty and apply again if their locations are occupied later. Other entries in each grant continue to work.

## Executables and protected values

An executable definition is attached to one resource, which remains the authorization target. Publishing creates a new immutable revision and selects it as active. A revision ID is never reused, and no operation modifies a published revision. Publishing requires a live resource, a live definition or no definition, a registered runtime, a valid host-independent shape, and successful runtime program validation.

Deleting an executable sets its deletion marker and clears its active revision. It does not delete revisions or audit history, and a deleted definition cannot publish again. Reads of a definition or its revisions require `read`; publish and delete require `write`.

A secret is a protected value addressed by resource ID through the universal `SecretStore` contract. An encrypted implementation stores a JSON-compatible `{ ciphertext, nonce, tag, version, updatedAt }` envelope. AES-256-GCM uses a fresh 96-bit nonce and authenticates the resource ID plus version as additional data. The command plane contains only public `{ resourceId, version, updatedAt }` metadata and never exposes trusted `resolve`.

Each persistence implementation stores envelopes natively; no separate backend protocol is required. SQLite commits its envelope and public metadata atomically, while a deployment may substitute a vault-compatible `SecretStore`. Runtime-private state remains protected credential data in a host-injected store, scoped by runtime name and resource ID. Secret mutation requires `write`; public metadata requires `read`; trusted plaintext resolution occurs only after the host has enforced `use`.

The runtime name identifies a host-registered implementation. The runtime registry is immutable deployment configuration from the repository's perspective: grants and executable programs cannot register, replace, or configure runtime code. RGAP defines no built-in fetch, GitHub, OpenAI, GraphQL, MCP, or language runtime. Deployments may supply such implementations.

## Generic invocation

```ts
type InvokeInput = {
  input: unknown;
  bindings?: Record<string, string>;   // slot name -> resource ID
  revisionId?: string;
};

type InvocationEvent =
  | { type: 'data'; value: unknown }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };
```

Invocation is one ordered decision and lifecycle:

1. Resolve the live executable definition and the requested revision, or its active revision when `revisionId` is omitted. The revision must belong to the invoked resource.
2. Authorize `invoke` on the executable resource using the complete grant lineage.
3. Validate input against `inputSchema`.
4. Reject undeclared bindings and missing required slots.
5. For every supplied binding, authorize `use` on its live resource using the complete lineage. If the slot access is `write`, also authorize `write`.
6. Resolve the registered runtime, validate its program again, and intersect revision limits with immutable host ceilings. A revision may narrow but not expand a ceiling.
7. Only after all authorization succeeds, resolve opaque handles for `secret` and `runtime-private` slots and invoke the runtime with an abort signal.
8. Validate every `data` event against `outputSchema` when it is not null, forward events in order, and record completion, error, or cancellation.

`resource` slots carry only resource identity and declared access. `secret` slots may carry an opaque secret handle. `runtime-private` slots may carry a handle owned by the selected runtime. Runtime-private mutation is available only through declared slots whose access is `write`; executable programs never receive an unrestricted credential store.

Invocation authorization is independent for the executable and every binding. Holding `invoke` does not imply `use`, and holding `use` does not expose, read, or mutate a protected value. Revocation affects the next decision. Cancellation propagates to the runtime through `AbortSignal`.

## Invocation auditing and redaction

An invocation record contains the executable resource ID, revision ID, runtime name, grant-lineage IDs, binding resource IDs, start and finish times, and result (`done`, `error`, or `cancelled`). It does not contain invocation input, output data, secret values, credential values, opaque handles, or runtime-private state. Implementations apply the same rule to logs and errors: protected material must not be copied into audit detail or public error messages.

Runtime-private writes first complete in the external credential store and then synchronize public metadata. Secret writes follow the same external-value/public-metadata split. These host stores are part of the trusted deployment boundary.

## Enforcement boundary

RGAP stores expose no commands directly. A caller selects one of two repository planes:

- `store.as(token)` returns commands authorized by that bearer token.
- `store.admin()` returns unrestricted commands for trusted bootstrap and operations code.

Both return the same repository interface. The token plane checks the required authority from the table above before each command and refuses with the decision's `detail` otherwise. The administrative plane enforces the protocol's own invariants — downscoping and ancestry — without token checks.

The store does not authenticate callers of `admin()`. Its host keeps the store object inside trusted process and module boundaries and applies infrastructure authentication to any remote administrative surface. Reads are shaped separately through the authority view, which reports the resources a token reaches and the permissions it holds on each.

## Conformance

An implementation conforms when:

1. Stable IDs are assigned once, never rewritten, and never reissued after deletion.
2. Paths are derived from names and canonicalized as defined. Operational paths resolve before resource commands; capability path targets resolve during every decision.
3. Permissions are compared as sets, with no implication between them.
4. `covers` is implemented exactly as defined, including lexical containment for two path targets and current-tree containment otherwise.
5. A grant is created, and its capabilities set, only when the result satisfies every validity rule, so authority never widens through delegation.
6. `authorize` checks the complete lineage and allows only what survives every grant in it.
7. Revocation cascades to delegated grants, and an inactive ancestor disables its descendants.
8. Resource operations and capability amendments commit their record changes and audit events as one atomic transition; capability amendments also commit any resulting child-grant revocations.
9. Deleted resources are retained as tombstones, excluded from every read, and their IDs stay permanently taken.
10. Stores expose command methods only through explicit `as(token)` or `admin()` plane selection.
11. `use` is a distinct permission with no implication, and every invocation binding requires it; a `write` slot additionally requires `write`.
12. Executable revisions are immutable, belong to exactly one resource, are validated by a registered runtime at publish and invoke, and remain retained after executable deletion.
13. Runtime registration and host ceilings are deployment configuration that repository commands cannot mutate.
14. Secret and runtime-private values remain outside public state; reads expose metadata only, and protected handles are resolved only after authorization.
15. Invocation resolves one revision, validates schemas and bindings, authorizes the executable and every binding through the complete lineage, forwards the defined event union in order, propagates cancellation, and records its result.
16. Audit records, errors, and logs exclude inputs, outputs, secret values, credential values, and handles while retaining the IDs, runtime, timing, and result needed for accountability.
