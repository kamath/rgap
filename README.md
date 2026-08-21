# RGAP: Hierarchical Capability Access

RGAP is an authorization model for filesystem-like resources, tools, and agent-accessible services. It supports hierarchical delegation, strict downscoping, fast revocation, and predictable access across resource moves and renames.

The model separates three concerns:

- **Resources** describe where objects live.
- **Grants** describe where authority comes from.
- **Tokens** are credentials used to exercise that authority.

Additional documents:

- [EXAMPLES.md](EXAMPLES.md) shows MCP server governance, tool aggregation, and sub-agent downscoping.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) defines the repository contract and Vite reference application.
- [LANDSCAPE.md](LANDSCAPE.md) compares RGAP with existing capability, authorization, and agent-access systems.

## Core model

### Resources

Resources form a tree, like folders and files. Every resource has a stable ID; its path is only its current location.

A resource record contains only its stable ID, parent resource ID, name, move policy, and delete policy. RGAP does not assign resource kinds such as organization, collection, server, folder, tool, or document. Applications may understand the objects referenced by resources, but that classification is not part of the resource hierarchy.

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

A move or deletion executes as one atomic engine operation:

1. Authorize the requested operation.
2. Read the affected resource and grant records from one state snapshot.
3. Identify grants affected by the operation.
4. Reject the operation or revoke the applicable grant subtrees.
5. Commit the resource-tree and grant changes together.
6. Record audit events in the same commit.

This prevents requests from observing a partially updated authorization state.

## Reference application

The repository contains a regular React and TypeScript Vite application at `apps/frontend`. It is a local, browser-only demonstrator for exercising RGAP and inspecting how authorization decisions are made. It requires no application server, database, authentication system, or external service.

The interface supports:

- Creating resources from names and human-readable parent paths
- Moving and deleting resources with selectable operation policies
- Creating root grants and delegating child grants
- Issuing, selecting, pasting, and revoking tokens
- Revoking a grant branch
- Simulating authorization requests
- Inspecting resource and grant trees through the active token's authority
- Viewing decision explanations and audit events
- Loading the scenarios from [EXAMPLES.md](EXAMPLES.md)

The resource explorer presents resources as a familiar expandable file tree. Each row shows the resource name, while selection exposes its complete path, stable ID, move policy, delete policy, and actions without crowding every tree row.

Resource creation asks for a name and a parent path. The parent-path combobox suggests existing paths such as `acme/mcp/google-drive/tools` and accepts a new path. When a submitted parent path does not exist, the command creates its missing path segments as ordinary resources before creating the named resource. The same form selects `move_policy` and `delete_policy` for the new resource.

Creation and movement use the same canonical path parser. Leading, trailing, and repeated separators are ignored, so `Acme`, `Acme/`, and `/Acme//` identify the same existing resource. A move accepts any canonical existing destination path, including moving a resource from a newly created root branch into an existing branch.

The application has one active-token control shared by the resource, grant, and authorization views. An empty token selects the unrestricted administrative inspection view. A valid bearer token changes the resource tree to show its authorized resources plus the ancestors needed to understand their paths, annotates visible resources with effective permissions, and focuses the grant view on the token's delegation lineage. An unknown, expired, or revoked token shows no authority and explains why. Issuing a token makes its bearer value active immediately; the user can then replace or clear that value to inspect another authority view.

The grant view always includes a grant form. In the administrative view it creates a root grant or delegates from any existing grant. In an active-token view it defaults to the token's selected grant and creates a downscoped child grant. The form selects the subject, parent grant, resource path, permissions, descendant behavior, relocation policy, and optional expiration.

The application separates domain behavior from state management and presentation:

```text
React interface
      ↓
RgapRepository interface
      ↓
BrowserRgapRepository
      ↓
Zustand browser store
```

The React interface calls an `RgapRepository` contract for every query and command. Components do not read or mutate Zustand state directly. `BrowserRgapRepository` implements that contract over a Zustand store and uses pure domain functions for validation, authorization, delegation, relocation, revocation, and audit-event creation.

The store contains resources, grants, token records, and audit events in normalized collections. Repository snapshots contain only this serializable application data; Zustand actions and other functions remain private to the adapter and never cross into domain operations. Each command computes and commits its complete state change atomically. Local persistence, when enabled, serializes the same application-state schema to browser storage. Raw bearer-token values exist only in transient UI memory; persisted token records contain only token hashes.

The repository contract uses asynchronous methods and JSON-compatible inputs and outputs even though the browser implementation is local. A future HTTP-backed repository can therefore replace `BrowserRgapRepository` at the application boundary without changing pages, components, or domain types. Backend-specific concerns such as transport, durable storage, concurrent transactions, authentication, and secret management remain outside the browser implementation.

The reference application does not expose a JSON API and is not a production authorization service. Browser state is appropriate for demonstrating the model, not for enforcing access between mutually untrusted parties.

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
