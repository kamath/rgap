# RGAP: Hierarchical Capability Access

RGAP is an authorization model for filesystem-like resources, tools, and agent-accessible services. It supports hierarchical delegation, strict downscoping, fast revocation, and predictable access across resource moves and renames.

The model separates three concerns:

- **Resources** describe where objects live.
- **Grants** describe where authority comes from.
- **Tokens** are credentials used to exercise that authority.

Additional documents:

- [EXAMPLES.md](EXAMPLES.md) shows MCP server governance, tool aggregation, and sub-agent downscoping.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) defines the package contract and TanStack Start reference application.
- [LANDSCAPE.md](LANDSCAPE.md) compares RGAP with existing capability, authorization, and agent-access systems.

## Core model

### Resources

Resources form a tree, like folders and files. Every resource has a stable ID; its path is only its current location.

```text
projects/
└── alpha/
    ├── docs/
    │   └── design/
    └── secret
```

Renaming or moving a resource changes its position in the tree without changing its identity.

### Grants

A grant contains one or more capability entries. Each entry authorizes a set of operations over a resource or resource subtree. Multiple entries let one grant aggregate authority from several branches, such as tools exposed by different MCP servers. Grants may delegate authority to child grants.

```text
Alice: read/write/delete projects/alpha
└── Bob: read projects/alpha/docs
    └── Carol: read projects/alpha/docs/design
```

Delegation may only downscope authority. A child grant can have:

- Capability entries covered by entries in its parent
- A root at or within the covering parent entry's authorized subtree
- The same or fewer permissions for each entry
- The same or an earlier expiration time
- A relocation policy no more permissive than its parent allows
- Constraints that are equal to or stricter than the covering parent entry

Bob therefore cannot grant write access or grant access outside `projects/alpha/docs`.

Every constraint type defines how one value contains another so the issuer can prove downscoping. For example, a child channel allowlist must be a subset of its parent's allowlist, and a child result limit must be less than or equal to its parent's limit.

### Tokens

Tokens are opaque bearer credentials that reference grants. Store only a cryptographic hash of each token.

Multiple tokens may reference one grant. Revoking a token disables only that credential; revoking a grant disables the grant and all grants delegated from it.

## Security invariant

> Authority may only stay the same or become narrower as it is delegated; it can never expand.

Authorization must check the selected grant and every grant in its delegation ancestry. Each child capability entry must remain covered by a parent entry. If any ancestor is revoked, expired, or otherwise inactive, its descendants are inactive as well.

## Moves and renames

Because grants reference stable resource IDs, renames require no authorization rewrite. Moves are governed by each grant's immutable relocation policy.

| Policy | Behavior when the grant root leaves its delegating scope |
| --- | --- |
| `follow_resource` | The grant stays attached to the resource and follows it. |
| `revoke_on_scope_exit` | The grant and its descendants are revoked. |
| `deny_move` | The move is rejected while the grant is active. |

The recommended default is `revoke_on_scope_exit`. It ensures delegated authority cannot survive somewhere the delegating parent no longer has access.

For example, suppose `secret` moves:

```text
projects/alpha/secret
        ↓
projects/private/secret
```

- A grant rooted at `alpha` no longer covers `secret` after the move.
- A direct grant rooted at `secret` follows it only when its relocation policy is `follow_resource`.
- A delegated grant rooted at `secret` is revoked when configured with `revoke_on_scope_exit`.
- The move fails when an applicable active grant uses `deny_move`.

`follow_resource` must not be available to a child grant unless the parent explicitly permits authority to survive a scope exit. Otherwise, relocation could be used to escape the parent's authority.

## Deletion

Resources may also define an operation policy:

```yaml
move_policy: normal        # normal | deny_while_granted
delete_policy: revoke      # revoke | deny_while_granted
```

Deleting a resource should revoke its grants rather than erase them. Retaining grant and revocation records preserves the audit trail.

## Atomic resource operations

A move or deletion should execute in one database transaction:

1. Authorize the requested operation.
2. Lock the affected resource and grant records.
3. Identify grants affected by the operation.
4. Reject the operation or revoke the applicable grant subtrees.
5. Update the resource tree.
6. Record audit events.

This prevents requests from observing a partially updated authorization state.

## Example grant

```yaml
id: grant_bob_docs
parent_grant_id: grant_alice_alpha
capabilities:
  - resource_id: resource_alpha_docs
    permissions: [read]
    descendant_policy: include
    relocation_policy: revoke_on_scope_exit
expires_at: 2026-12-31T23:59:59Z
revoked_at: null
```

Permission relationships should be explicit. For example, the system must define whether `write` implies `read`, whether `delete` applies to the root itself or only its descendants, and which permissions are required to move a resource between parents.

## Design summary

```text
Resource tree = where things live
Grant tree    = where authority comes from
Token         = credential used to exercise a grant
```

Stable identities make renames and moves manageable. Immutable, downscoped grants make delegated authority understandable. Hierarchical revocation allows an entire delegation branch to be disabled without updating every descendant individually.
