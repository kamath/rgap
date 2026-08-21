# RGAP Protocol

This document is the normative definition of RGAP: the records, the permission algebra, the delegation rules, and the decision procedure. [README.md](README.md) explains the model and its intent, [IMPLEMENTATION.md](IMPLEMENTATION.md) describes the reference packages, and this document defines what any implementation must compute.

Everything here is expressed over one immutable state value. An implementation conforms when, given the same state and the same request, it reaches the same decision.

## Records

State is four normalized collections.

```ts
type State = {
  resources: Record<string, Resource>;
  grants: Record<string, Grant>;
  tokens: Record<string, Token>;
  audit: AuditEvent[];
};
```

```ts
type Resource = {
  id: string;                                        // stable identity, assigned once
  parentId: string | null;                           // null for a root
  name: string;                                      // unique among live siblings, contains no separator
  movePolicy: 'normal' | 'deny_while_granted';
  deletePolicy: 'revoke' | 'deny_while_granted';
  deletedAt: string | null;                          // tombstone marker
};

type Capability = {
  resourceId: string;                                // the entry's root
  permissions: Permission[];                         // a set; order is not significant
  descendants: boolean;                              // whether the entry covers the root's subtree
  relocation: RelocationPolicy;
};

type Grant = {
  id: string;
  name: string;
  subject: string;                                   // opaque to the model
  parentId: string | null;                           // null for a root grant
  capabilities: Capability[];                        // at least one
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

type AuditEvent = {
  id: string;
  at: string;                                        // RFC 3339 timestamp
  action: string;
  target: string;                                    // the stable ID the event concerns
  result: 'allowed' | 'denied' | 'recorded';
  detail: string;
};
```

`Permission` is `'read' | 'write' | 'delete' | 'move' | 'invoke'`. `RelocationPolicy` is `'follow_resource' | 'revoke_on_scope_exit' | 'deny_move'`.

Every record is JSON-compatible. Timestamps are RFC 3339 strings compared lexicographically, which requires them to be UTC with a fixed number of fractional digits.

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

Path resolution belongs to the caller. Every command names resources by stable ID, so an implementation resolves a path at the moment it reads state, not at the moment a command executes. This binds a request to the resource the caller observed rather than to whatever later occupies that path.

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

`resourcePath` continues to resolve for a tombstone, so a revoked grant can still report the path its capability referred to.

## Permissions

| Permission | Authorizes |
| --- | --- |
| `read` | Reading the resource and listing its children. |
| `write` | Modifying what the resource refers to, and creating children under it. |
| `invoke` | Calling the resource, such as executing a tool. |
| `move` | Relocating the resource to a different parent. |
| `delete` | Deleting the resource together with its descendants. |

**No permission implies another.** Permissions form a plain set, compared by subset. `write` does not imply `read`, and no permission is granted by holding another. Implication would require delegation to compare closures rather than sets, and it would make write-only authority inexpressible. Implementations that want familiar bundles apply presets when a grant is issued; the algebra underneath stays a set.

Each operation requires this authority:

| Operation | Required authority |
| --- | --- |
| Read a resource, list its children | `read` on the resource |
| Invoke a resource | `invoke` on the resource |
| Create a child resource | `write` on the intended parent |
| Move a resource | `move` on the resource **and** `write` on the destination parent |
| Delete a resource and its descendants | `delete` on the resource |
| Delegate a child grant | The delegating grant is the grant the token references, and the child downscopes it |
| Issue or revoke a token | The token's grant is the acting token's grant or a grant delegated from it |
| Revoke a grant | The grant is the acting token's own grant or one delegated from it |

A move requires authority at both ends because relocation changes who reaches the resource. Without `write` on the destination, a move would place a resource inside a scope the mover does not hold.

Creating a root resource, moving a resource to a root, and creating a root grant are administrative operations. No token authorizes them, because there is no resource or grant above them to derive authority from.

## Capability algebra

Two relations define everything else: what a capability authorizes, and when one capability contains another.

### Authorization by a single entry

```ts
authorizes(capability, resources, resourceId, permission) =
  capability.permissions.includes(permission) &&
  (capability.descendants
    ? isWithin(resources, resourceId, capability.resourceId)
    : capability.resourceId === resourceId)
```

### Containment

`covers(parent, child)` holds when every request the child entry authorizes is also authorized by the parent entry.

```ts
const rank = { deny_move: 0, revoke_on_scope_exit: 1, follow_resource: 2 };

covers(parent, child, resources) =
  location(parent, child, resources) &&
  rank[child.relocation] <= rank[parent.relocation] &&
  child.permissions.every((permission) => parent.permissions.includes(permission));

location(parent, child, resources) =
  parent.descendants
    ? isWithin(resources, child.resourceId, parent.resourceId)
    : parent.resourceId === child.resourceId && !child.descendants;
```

Each clause is a containment proof over one dimension:

- **Location.** A parent entry that covers a subtree contains any child entry rooted inside that subtree, with or without its own descendants, because that child's reach is a subset of the parent's. A parent entry that covers only its root contains only a child rooted at the same resource and reaching no further. A child never widens `descendants` past its parent.
- **Relocation.** A child's policy is no more permissive than its parent's, ordered `deny_move` < `revoke_on_scope_exit` < `follow_resource`. `follow_resource` is available to a child only when the covering parent entry is itself `follow_resource`, which is how a parent explicitly permits delegated authority to survive a scope exit.
- **Permissions.** The child's set is a subset of the parent's.

Location containment is evaluated against the current tree, and it is required in every case. Relocation policy governs what happens to an *existing* grant when its resource later moves; it never substitutes for containment at the moment a grant is issued.

## Grants

### Validity at issue

A grant is created only when all of the following hold:

1. `name` and `subject` are non-empty.
2. `capabilities` has at least one entry, each with at least one permission and a `resourceId` naming a live resource.
3. If `parentId` is set, the parent grant exists and is active.
4. If the parent has an `expiresAt`, the child has one and it is no later than the parent's.
5. Every child capability entry is covered by at least one parent capability entry, by `covers` above.

Rules 4 and 5 are the downscoping proof. A root grant, having no parent, is unconstrained by them and is therefore administrative.

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
4. Let `leaves` be the entries of `chain[0]` — the grant the token references — that satisfy `authorizes(entry, resources, resourceId, permission)`.
5. Allow when some leaf entry is covered by at least one entry of *every* remaining grant in the chain:

```ts
allowed = leaves.some((leaf) =>
  chain.slice(1).every((ancestor) =>
    ancestor.capabilities.some((entry) => covers(entry, leaf, resources))));
```

Step 5 is the security invariant made executable. Authority is the intersection of the whole chain: an entry that no longer sits inside an ancestor's authority authorizes nothing, whatever the leaf grant says.

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

Each operation is one atomic state transition. It reads one snapshot, computes the complete next state — resource changes, grant revocations, and audit events together — and commits once. A request never observes a partially updated authorization state.

### Create

Requires a non-empty name containing no `/`, a live parent when `parentId` is set, an unused ID, and no live sibling of the same name under that parent. The new resource is live.

### Move

`move(state, id, parentId, at)`:

1. The resource is live, and the destination parent is live or `null`.
2. The destination is neither the resource itself nor within its subtree, which would create a cycle.
3. Let `affected` be the active grants holding a capability rooted inside the moved subtree.
4. If the resource's `movePolicy` is `deny_while_granted` and `affected` is non-empty, reject.
5. Reparent the resource.
6. For each affected grant that has a parent grant, compute the entries that are *no longer covered* by that parent grant in the new tree. This is the scope exit.
   - Any such entry with `deny_move` rejects the whole operation.
   - Otherwise, any such entry with `revoke_on_scope_exit` revokes that grant and everything delegated from it.
   - Entries with `follow_resource` survive: the grant stays attached to the resource in its new location.
7. Commit the reparenting, the revocations, and the audit event together.

Because grants reference stable IDs, a rename — a change of `name` with no change of `parentId` — requires no authorization rewrite at all.

### Delete

`delete(state, id, at)`:

1. The resource is live.
2. Let `removed` be the live resources within its subtree, and `affected` the active grants holding a capability rooted at any of them.
3. If the resource's `deletePolicy` is `deny_while_granted` and `affected` is non-empty, reject.
4. Revoke each affected grant and everything delegated from it.
5. Mark every resource in `removed` with `deletedAt`.
6. Commit the tombstones, the revocations, and the audit event together.

Deletion revokes grants rather than erasing them, and tombstones resources rather than removing them, so the audit trail stays resolvable.

## Enforcement boundary

RGAP decides; the host enforces.

`authorize` is the decision function. The repository commands defined above are an administrative plane: they enforce the model's own invariants — downscoping, relocation policy, ancestry, resource policy — but they do not demand a token. This keeps the model embeddable behind whatever transport, session, or service identity a host already has.

A host that wants a token-scoped surface composes two pieces:

- **Commands** run through a guard that checks the required authority from the table above before delegating, and refuses with the decision's `detail` otherwise.
- **Reads** are shaped by the authority view, which reports the resources a token reaches and the permissions it holds on each.

The reference implementation ships the guard as `guardCommands(repository, token)` so that hosts do not each re-derive the table.

## Conformance

An implementation conforms when:

1. Stable IDs are assigned once, never rewritten, and never reissued after deletion.
2. Paths are derived from names, canonicalized as defined, and resolved by the caller before a command is issued.
3. Permissions are compared as sets, with no implication between them.
4. `covers` is implemented exactly as defined, including location containment in every case.
5. A grant is created only when it satisfies every validity rule, so authority never widens through delegation.
6. `authorize` checks the complete lineage and allows only what survives every grant in it.
7. Revocation cascades to delegated grants, and an inactive ancestor disables its descendants.
8. Resource operations commit their resource changes, grant revocations, and audit events as one atomic transition.
9. Deleted resources are retained as tombstones, excluded from every read, and their IDs stay permanently taken.
