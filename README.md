# RGAP: Hierarchical Capability Access

RGAP is an authorization model for filesystem-like resources, tools, and agent-accessible services. It supports hierarchical delegation, strict downscoping, fast revocation, and predictable access across resource moves and renames.

The model separates three concerns:

- **Resources** describe where objects live.
- **Grants** describe where authority comes from.
- **Tokens** are credentials used to exercise that authority.

Additional documents:

- [PROTOCOL.md](PROTOCOL.md) is the normative specification: records, permission algebra, delegation rules, and the decision procedure.
- [EXAMPLES.md](EXAMPLES.md) shows MCP server governance, tool aggregation, and sub-agent downscoping.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) defines the repository contract and Vite reference application.
- [LANDSCAPE.md](LANDSCAPE.md) compares RGAP with existing capability, authorization, and agent-access systems.

## Core model

### Resources

Resources form a tree, like folders and files. Every resource has a stable ID; its path is only its current location.

A resource record contains only its stable ID, parent resource ID, name, move policy, delete policy, and deletion marker. RGAP does not assign resource kinds such as organization, collection, server, folder, tool, or document. Applications may understand the objects referenced by resources, but that classification is not part of the resource hierarchy.

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

Delegation may only downscope authority, entry by entry, as [PROTOCOL.md](PROTOCOL.md) defines. A child grant can have:

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

RGAP decides; the host enforces.

`authorize` is the decision function. It answers whether one token may exercise one permission on one resource, and it explains the answer. The repository's commands are an administrative plane: they express what a state change is and enforce the model's own invariants — downscoping, relocation policy, resource and grant ancestry — but they do not themselves demand a token. This keeps the model embeddable behind any transport, session model, or service identity a host already has.

Because that boundary is easy to implement inconsistently, the reference implementation ships the enforced path rather than leaving each host to derive it. `guardCommands(repository, token)` wraps any `RgapRepository` and returns one with the same interface whose commands each check the authority above before delegating, and refuse with the decision's explanation otherwise.

`guardCommands` guards commands; it does not filter reads. The read-side lens is `inspectToken`, which reports the resources a token reaches and the permissions it holds on each. A host that wants a token-scoped API composes the two: guarded commands for writes, the authority view for reads.

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

Deletion marks the resource and its descendants as deleted rather than erasing their records. A deleted resource is gone for every purpose an application can observe: it appears in no listing, no path resolves to it, no command targets it, and no request is authorized against it. Its record is retained so that its stable ID is never reissued to a different resource, which keeps every revoked grant and audit event that references the ID resolvable to what it actually meant.

Because a retained record is identified by ID rather than by path, a deleted name is not reserved. A new resource may take a deleted resource's name under the same parent; it is a different resource and receives its own new stable ID.

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

The repository contains a React, TypeScript, and Vite application at `apps/frontend`, routed by TanStack Router. It is a local, browser-only demonstrator for exercising RGAP and inspecting how authorization decisions are made. It requires no application server, database, authentication system, or external service.

The interface is a protocol workbench. Every route states what it operates on, shows the current state in a reading pane, and executes repository calls from an operations pane that displays the request it sends and the response it receives. Resources browse like an object store: the URL holds the current resource path, a breadcrumb shows where that path sits, and the explorer lists one location at a time.

### Routes

| Route | View |
| --- | --- |
| `/` | Redirects to the resource explorer root. |
| `/browse/$path` | Resource explorer for the resource at `$path`. An empty splat lists the tree roots. |
| `/grants` | Every grant as an indented delegation tree. |
| `/grants/$grantId` | One grant's capabilities, tokens, delegation form, and revocation. |
| `/authorize` | Authorization simulator. |
| `/audit` | Audit events, newest first. |

The header is present on every route. It holds the route links, the active-token control, and a button that resets the store to the deterministic example state.

### Interface

The application is dark, typographic, and flat. Structure comes from hairline rules rather than shadows, rounding, or fills.

- Near-black surfaces, hairline borders, and one accent colour. The accent marks the selected tab, an active status, and an allowed decision; a red tone marks a denied decision, an inactive grant, and a rejected command.
- Monospace for every protocol value: paths, stable IDs, permissions, policies, token hashes, timestamps, and JSON. Proportional type only for page titles and prose.
- Uppercase monospace eyebrows label the workbench and each pane. Each route opens with a large title and a one-line note about what backs it.
- Route navigation is a tab strip of bordered cells. The selected route fills with the accent colour.
- Panes are bordered cells in a grid: a pane label on the left of its head, dim monospace metadata on the right.
- A command runs from one pale full-width execute button per operations pane. Its result appears in the response pane, and the status line under the header reports the outcome in monospace.

### Operations panes

Every command runs through the same pane pair. The request pane holds the form and, under it, the exact repository call the form will make as monospace JSON. The response pane holds the returned record, decision, or error as monospace JSON. The request preview is a read-only rendering of the form, not a JSON editor, so the domain rules always receive typed input.

Every repository command names resources by stable ID, never by path. Forms still accept a path, because a path is what a person can read and type; the interface resolves it against the current tree and sends the resolved ID, and the request preview shows that ID. A path that resolves to nothing has no ID to show, so the request preview omits it and the form marks it; executing anyway reports it in the response pane before any command is sent.

An operations pane with more than one command presents them as a tab strip above the form:

| Route | Operations |
| --- | --- |
| `/browse/$path` | Create resource, Move, Delete |
| `/grants` | Create root grant |
| `/grants/$grantId` | Delegate, Issue token, Revoke grant |
| `/authorize` | Authorize |

### Resource explorer

The explorer path is the canonical resource path, so `/browse/acme/drive` addresses `acme/drive` and the browser's back button walks back out of the tree. Leading, trailing, and repeated separators are ignored, so `/browse/acme`, `/browse/acme/`, and `/browse//acme//` address the same resource.

The explorer shows one location at a time, the way a file viewer does. A breadcrumb above the panes spells out the current path as `root / acme / mcp`, and every segment navigates to that ancestor.

The contents pane lists the live children of the current path: one row per child with its name, stable ID, move policy, delete policy, and permissions under the active token. Deleted resources appear in no listing. Clicking a name navigates into that child, replacing the listing with that child's contents; a leading `..` row navigates to the parent. Selecting a row targets the move and delete operations at it, and the row stays marked while it is the target. Because RGAP assigns no resource kinds, a resource with no children lists nothing.

The object pane describes the resource the path addresses: its full path, stable ID, move policy, delete policy, and effective permissions under the active token.

The explorer's operations pane creates, moves, and deletes. Create takes a name, a parent path prefilled with the current path, a `move_policy`, and a `delete_policy`. When the submitted parent path does not exist, the interface creates each missing segment as its own ordinary resource before creating the named resource, so that convenience is a sequence of commands rather than one commit: a rejected segment leaves the segments already created. Move takes a destination parent path, resolved the same way, and an empty path moves the resource to a root. Delete removes the selected resource and its descendants. Move and delete default to the resource the path addresses and retarget to whichever row is selected.

### Active token

One active-token control in the header applies to every route. An empty token selects the unrestricted administrative view. A valid bearer token narrows every listing to the resources that token reaches plus the ancestors needed to understand their paths, annotates those resources with effective permissions, and focuses the grant view on the token's delegation lineage. An unknown, expired, or revoked token shows no authority and explains why. Issuing a token makes its bearer value active immediately; the user can then replace or clear that value to inspect another authority view.

The active token also selects which plane commands run on. With no token, operations run on the administrative plane. With a valid token, the interface routes its commands through `guardCommands`, so an operation that token does not authorize is refused with the decision's explanation in the response pane, and the operations pane names the plane it is sending to.

Bearer values stay in transient interface memory. The active token never appears in a route path, a search parameter, or browser storage.

### Grants

The grant list renders the whole delegation tree at once: each grant is indented under the grant it was delegated from, with its subject, capability count, expiration, and status. Revoked and expired grants are marked as inactive.

A grant's page shows its capabilities as a table of resource path, permissions, descendant behavior, and relocation policy, marking any capability whose resource has been deleted while still showing the path that resource held; its issued tokens with labels and status; and the delegation lineage from the root grant down to it. Its operations pane delegates a child grant, issues a token, and revokes the grant branch, and each issued token row revokes that token. The delegation form selects the subject, resource path, permissions, descendant behavior, relocation policy, and optional expiration; the domain rules reject any child that would expand authority and the response pane shows the reason. The grant list creates root grants in the administrative view.

### Authorization and audit

The simulator is the plainest operations pane: its request takes a token, a resource path, and a permission, and its response reports whether the request is allowed, the explanation, the grant it resolved to, and the grant lineage it checked. The verdict is stated in the accent colour when allowed and in red when denied.

The audit route is one full-width log pane. It lists recorded events in monospace with their timestamp, action, target, result, and detail, so a move that revoked a delegated branch or a denied request is visible after the fact.

### Architecture

The application separates domain behavior from state management and presentation:

```text
React interface
      ↓
@rgap/react hooks
      ↓
RgapClient observable cache
      ↓
RgapRepository in @rgap/core
      ↓
Browser storage or an HTTP API
```

`@rgap/core` contains the JSON-compatible domain records, pure RGAP rules, and asynchronous `RgapRepository` contract. The repository is a request-response boundary: it reads the current state and exposes asynchronous query and command methods. It does not expose a subscription and does not require a streaming transport. The package has no dependency on React, Zustand, browser storage, or a transport.

Every method of that contract addresses resources by stable ID. A resource path describes only where a resource currently sits, so it is a presentation concern: `@rgap/core` exports the pure helpers that render a resource's path and resolve a path to an ID, and callers use them before they issue a command. Keeping resolution outside the boundary means a command can never act on whatever happens to occupy a path at the moment it arrives.

`@rgap/browser` implements `RgapRepository` over local storage. It accepts initial state from its caller, so the package has no dependency on the reference application's example data.

`@rgap/react` provides an `RgapClient` that owns a cached snapshot, a client-local subscription, and the repository used to load and mutate state. It also provides a client context plus hooks for the current snapshot, repository commands, and token-derived authority. After a command completes, the client reloads the repository state and notifies its local subscribers. React components therefore retain reactive snapshots without requiring the repository or a remote backend to implement SSE, WebSockets, or another push protocol. The Vite application owns only its example seed, interface components, and styles.

The store contains resources, grants, token records, and audit events in normalized collections. Repository snapshots contain only this serializable application data; Zustand actions and other functions remain private to the adapter and never cross into domain operations. Each command computes and commits its complete state change atomically. Local persistence, when enabled, serializes the same application-state schema to browser storage. Raw bearer-token values exist only in transient UI memory; persisted token records contain only token hashes.

The repository contract uses asynchronous methods and JSON-compatible inputs and outputs even though the browser implementation is local. An HTTP-backed repository implements ordinary request-response operations, including a state read, and can replace `BrowserRgapRepository` without changing pages, components, or domain types. Live updates from changes made by other clients are optional client behavior. A client may refresh on demand, on window focus, or on an interval, and may add a streaming transport when an application specifically needs one. Backend-specific concerns such as transport, durable storage, concurrent transactions, authentication, and secret management remain outside the browser implementation.

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

## Design summary

```text
Resource tree = where things live
Grant tree    = where authority comes from
Token         = credential used to exercise a grant
```

Stable identities make renames and moves manageable. Immutable, downscoped grants make delegated authority understandable. Hierarchical revocation allows an entire delegation branch to be disabled without updating every descendant individually.
