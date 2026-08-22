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

`as(token)` guards commands and scopes queries. A query answers with what its plane may see: everything on the administrative plane, and on a token plane the resources that token reaches together with the ancestors that explain their paths, each annotated with the permissions the token holds there. A grant query on a token plane answers with the grants that token explains, which are the lineage above its own grant and everything delegated from it, and an audit query answers with the events whose target the plane may see. A host renders what a query returns rather than filtering it, because a boundary that hands back rows the caller must discard has already leaked the thing it was guarding.

`inspectToken(token)` reports whether a presented bearer is usable and which grant and lineage it references. `authorize(token, resourceId, permission)` answers one decision about it. Both concern any presented bearer rather than inheriting the repository's command token.

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

## Reference application

The repository contains a React, TypeScript, and Vite application at `apps/frontend`, routed by TanStack Router. It is a local, browser-only demonstrator for exercising RGAP and inspecting how authorization decisions are made. It requires no application server, database, authentication system, or external service.

The interface is a protocol workbench. Every route states what it operates on, shows the current state in a reading pane, and executes repository calls from an operations surface that displays the request it sends and the response it receives. Resources browse like an object store: the URL holds the current resource path, a breadcrumb shows where that path sits, and the explorer lists one location at a time as the full width of the route. Its operations open one at a time in a drawer beside the listing, so the listing is what the route shows when no operation is in progress.

### Routes

| Route | View |
| --- | --- |
| `/` | Redirects to the resource explorer root. |
| `/browse/$path` | Resource explorer for the resource at `$path`. An empty splat lists the tree roots. |
| `/grants` | Delegation explorer for the root grants. |
| `/grants/$grantId` | Delegation explorer for the grants delegated from `$grantId`. |
| `/grants/$grantId/inspect` | One grant in full: its lineage, capabilities, and tokens. |
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
- A command runs from one pale full-width execute button per operations surface, and its result appears as monospace JSON in the same surface.
- A drawer is a pane in a column at the right edge of the route, separated from the content beside it by a hairline. It carries the same head, label, and metadata as any other pane, and the content beside it stays visible and usable while it is open.
- Action bar buttons are bordered cells in the text colour, bright enough to read as controls rather than metadata. The button whose drawer is open fills with the accent colour, and a button with nothing to act on dims to the metadata colour.
- The status line under the header reports the active token's authority. Command outcomes are not reported there; they belong to the surface the command was sent from.

### Operations surfaces

Every command runs through the same request-and-response pair. The request holds the form and, under it, the exact call the form will make as monospace JSON: a collection method on the repository, a method on a resource, grant, or token handle, or `grant.tokens.create`. The response holds the returned record, decision, or error as monospace JSON. The request preview is a read-only rendering of the form, not a JSON editor, so the domain rules always receive typed input.

Every command names resources by stable ID, never by path. A handle is that ID plus the collections and methods that act on it. Forms still accept a path, because a path is what a person can read and type; the interface resolves it with `resources.at`, and the request preview shows the ID that handle carries. A path that resolves to nothing has no ID to show, so the request preview omits it and the form marks it; executing anyway reports it in the response before any command is sent.

Routes present their operations one of two ways. An operations pane sits beside a response pane and is always open, which suits the simulator, whose whole purpose is the form. A drawer holds one operation, opens from a named button in an action bar, and closes when that operation is finished or abandoned, so a route with drawers shows no form until one is asked for.

| Route | Operations | Presentation |
| --- | --- | --- |
| `/browse/$path` | Create resource, Move, Delete | Drawer, one operation at a time |
| `/grants` | Create root grant, Revoke grant | Drawer, one operation at a time |
| `/grants/$grantId` | Create grant, Revoke grant | Drawer, one operation at a time |
| `/grants/$grantId/inspect` | Issue token, Revoke token | Drawer, one operation at a time |
| `/grants/$grantId/inspect` | Set capabilities | The Capabilities pane, in place |
| `/authorize` | Authorize | Operations pane |

### Listings and drawers

Two routes are built the same way, so browsing resources and walking grants read as one interface.

A listing is the route's main view. It shows one record's contents at a time, the way a file viewer does, and spans the full width of the route. A breadcrumb above it walks back out of the tree, and under the breadcrumb one monospace line states the facts of the record the route addresses. A listing renders one page of a query's answer and continues with the cursor that answer carries, so a location holding many records is read a page at a time.

Every listing row carries a checkbox, and clicking a row anywhere but its link checks it. A checkbox in the listing head checks and unchecks every row at once. A leading `..` row navigates to the parent. The selection covers only the page the listing shows: navigating, and continuing to the next page, clears it, because the listing is what the checkboxes describe. Reading the selection back out of the listing on every render drops whatever a committed command removed from it.

An action bar in the listing head holds that listing's operations. One of them creates a record inside the record the route addresses and is always available. The rest act on the selection, name the count they would act on, as `Delete 3`, and are unavailable while nothing is checked. An action bar may also hold a link rather than an operation, which navigates instead of opening a drawer.

Each button opens its operation in a drawer, and one drawer is open at a time across the route, so asking for another operation replaces the open one. The listing stays live while a drawer is open: checking and unchecking rows retargets the operation, and the drawer's target list and request preview follow the selection. Losing the selection closes a drawer that acts on it. A drawer closes when its operation commits, from the close control in its head, and on `Escape`; a refused command leaves it open with the decision's explanation in its response so the form can be corrected. One operation is exempt: issuing a token returns a value that exists nowhere else, so its drawer stays open holding that value and only the close control or `Escape` dismisses it.

An operation over several records is several commands, one per selected record, sent in listing order. The drawer reports one result per record in its response, so a selection where some commands are authorized and others are refused shows exactly which were applied.

### Resource explorer

The explorer path is the canonical resource path, so `/browse/acme/drive` addresses `acme/drive` and the browser's back button walks back out of the tree. Leading, trailing, and repeated separators are ignored, so `/browse/acme`, `/browse/acme/`, and `/browse//acme//` address the same resource.

The breadcrumb spells out the current path as `root / acme / mcp`, and every segment navigates to that ancestor. The line under it states the addressed resource's stable ID, effective permissions under the active token, and child count.

The listing has one row per live child of the current path, with the child's name, stable ID, and permissions under the active token. Deleted resources appear in no listing. Clicking a name navigates into that child, replacing the listing with that child's contents. Because RGAP assigns no resource kinds, a resource with no children lists nothing.

The create drawer takes a name. It creates the resource on the handle the listing shows: a child via `resource.create` when a resource is addressed, and a root via `resources.create` at the tree root, which no token authorizes and which the guarded plane therefore refuses. The parent is that location, stated as a read-only path rather than typed, so creating somewhere else means navigating there first.

The move drawer lists the checked resources as paths and takes one destination parent path, resolved against the current tree to the stable ID the commands send, where an empty path moves them to roots. The delete drawer lists the checked resources as paths and removes each together with its descendants.

### Active token

One active-token control in the header applies to every route. An empty token selects the unrestricted administrative view. A valid bearer token narrows every listing to the resources that token reaches plus the ancestors needed to understand their paths, annotates those resources with effective permissions, and focuses the grant view on the token's delegation lineage. An unknown, expired, or revoked token shows no authority and explains why. Issuing a token makes its bearer value active immediately; the user can then replace or clear that value to inspect another authority view.

The active token also selects which plane commands run on. With no token, operations use `store.admin()`. With a valid token, operations use `store.as(token)`, so an operation that token does not authorize is refused with the decision's explanation in the response pane, and the operations pane names the plane it is sending to.

Bearer values stay in transient interface memory. The active token never appears in a route path, a search parameter, or browser storage.

### Grants

Grants are explored the way resources are. `/grants` lists the root grants, `/grants/$grantId` lists the grants delegated from that grant, and clicking a grant's name navigates into it, replacing the listing with the grants delegated from it. A leading `..` row walks back out. The breadcrumb walks the delegation lineage as `grants / Acme admin / Drive read`, and every name navigates to that ancestor grant. The line under it states the addressed grant's stable ID, expiration, status, and the number of grants delegated from it.

A grant row states the grant's name, each capability entry as a resource path and permission set, expiration, and status. A revoked or expired grant is marked inactive, and so is every grant delegated beneath it, because an inactive ancestor disables its descendants. Status is therefore a property of a grant's lineage rather than of the grant record alone, and the listing reports it that way.

The listing's action bar creates, revokes, and inspects. `Create` creates a grant on the handle the route addresses: at `/grants/$grantId` that is `grant.create`, and at `/grants` it is a root via the administrative collection, which no token authorizes. A token delegates with `grants.create` on its own plane, which mints a child of the acting grant; the workbench sends that as `grant.create` from the acting grant's listing. Its form takes the name and optional expiration and nothing else. The new grant starts with no capability entries, because what a grant reaches is set from the grant itself, where the whole set is visible at once. `Revoke` revokes each checked grant together with the grants delegated from it, and its drawer lists those descendants under each target, so the extent of a revocation is stated before it runs.

`Inspect` is the one action bar entry that navigates rather than opening a drawer. It addresses the same grant the route addresses, so it is present wherever a grant is addressed and absent at `/grants`, where the route addresses no grant and a root grant is reached by navigating into it.

### Inspecting a grant

`/grants/$grantId/inspect` is one grant in full. Browsing a delegation branch and reading a grant's authority are different tasks, so they are different routes: the listing stays a listing, and everything a grant is sits behind one link from it. The breadcrumb walks back out to the grant's own listing and on up its lineage.

Lineage is a read-only table of the delegation chain from the root grant down to the addressed grant, one row per capability entry, grouped under the grant that holds it. Reading down the table is reading the downscoping: targets narrow, permission sets shrink, and expirations move earlier. It is the view that answers whether a grant's authority survives everything above it.

Capabilities is the addressed grant's own entries: whether each names a `resourceId` or a `path`, that value, and the permission set. An ID entry whose resource has been deleted is marked deleted and still shows the path that resource held. A path entry whose location is empty is marked empty and remains editable.

Its action bar holds `Set capabilities`, the one operation that changes what a grant reaches. Setting replaces the whole set in one command, so the operation opens seeded with the entries the grant holds now and executes the set it is left in.

Whether that action is offered depends on the plane the active token selects. On the administrative plane it is always offered, bounded only by the parent grant. On the guarded plane the pane states what the active token can do before a form opens, rather than letting a form be filled in and the command refused: a token on a grant above the addressed grant is offered the action, and a token that is not is offered the reason in its place.

A token on the addressed grant itself is refused, because a grant does not amend itself. Its holder would widen it to the authority its issuer withheld, so raising what a grant reaches belongs to the grant above it. The note therefore names that parent grant and links to it, because a token on the parent is what performs the operation. A token on a grant that is neither the addressed grant nor above it is refused as outside that branch, and a root grant's entries are administrative, so no token amends them. These are the guard's own rules, stated where the operation would be started instead of where it would fail.

This is the one operation that does not open in a drawer. A drawer exists so a form can sit beside content that stays useful while it is open, and here that content is the very table the form edits. So the pane becomes the form in place: the entries stay where they were, gain their controls, and the pane grows an execute button and a response. Until `Set capabilities` is pressed the pane is a reading pane, so the route still shows no form until one is asked for.

### Choosing targets

Each entry explicitly selects `resource ID` or `path`. ID targets use the resource picker: a breadcrumb walks the current tree, rows select live resources, and a whole-path filter reaches deep resources directly through `resources.search`. Path targets use a normalized path field and do not require the path to be occupied, so a grant can reserve authority for a location that is currently empty.

Under the target controls is one row per entry, in order, stating whether it names a `resourceId` or a `path`, that value, and its permission checkbox set. Permissions default to none, and the form marks an entry that has none, because an entry with no permission is not valid. Every entry covers the target and its subtree; there is no per-entry extent control.

For a child grant, available targets and permissions are bounded by the parent grant, and the form learns those bounds from `grant.delegable` on that parent. A child ID target must currently resolve within a covering parent entry. A child path target may be delegated while empty when a parent path entry lexically covers it; otherwise it must currently resolve within a covering parent entry. The domain check remains authoritative, and authorization checks every grant in the lineage against the requested live resource so later moves cannot expand delegated authority.

Tokens is a listing with its own checkboxes and action bar, holding one row per issued token with its label, status, and hash prefix. Its action bar issues and revokes. `Issue token` takes a label and issues a token for the grant the route addresses. Only a hash of that token is stored, so the bearer value the command returns is the only copy there will ever be: the drawer stays open after it commits, states the value on a line of its own, and offers a control that copies it. The value also becomes the active token immediately, so the header carries it until it is replaced or cleared, and the drawer says plainly that dismissing it is the last chance to read the value. `Revoke token` revokes each checked token, which disables that credential and leaves the grant intact.

### Authorization and audit

The simulator is the plainest operations pane: its request takes a token, a resource path, and a permission, and its response reports whether the request is allowed, the explanation, the grant it resolved to, and the grant lineage it checked. The verdict is stated in the accent colour when allowed and in red when denied.

The audit route is one full-width log pane. It lists recorded events in monospace with their timestamp, action, target, result, and detail, so a move that revoked a delegated branch or a denied request is visible after the fact. It pages the newest events first and continues with the cursor its query carries, because a log is the one collection that only grows.

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
Browser storage, a SQLite database, or an HTTP API
```

`@rgap/core` contains the JSON-compatible domain records, pure RGAP rules, and asynchronous `RgapStore` and `RgapRepository` contracts. Identities in that TypeScript surface are branded (`ResourceId`, `GrantId`, `TokenId`, `TokenValue`, `TokenHash`); they serialize as ordinary strings. A store owns persistence and exposes only `as(token)` and `admin()` command-plane selection. `as` takes a `TokenValue`. Neither contract exposes a subscription or requires a streaming transport. The package has no dependency on React, Zustand, browser storage, or a transport.

A repository is the request-response interface returned by `as` or `admin`. It exposes collections, looks up existing records, answers bounded queries about them, and answers decision queries. Creating a grant or a resource is one command; the parent is an argument. TypeScript fills that argument from the receiver so the caller does not pass it.

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

### Queries

Every read is a query with a bounded answer. No call returns the store. A read that grows with everything the store has ever held cannot be served over a network, cached, or paged, and it hands a caller the records its plane exists to withhold.

A query hangs off the record it concerns, the way a command does. A resource lists its children. A grant lists what it delegates, its lineage, the branch a revocation would reach, and the tokens issued against it. The collections answer for the tree roots and for the lookups that are anchored to no record: resolving a path, and searching for a resource by path.

```ts
type Page<T> = { items: T[]; nextCursor: string | null };
type PageRequest = { cursor?: string; limit?: number };
type CapabilityTarget = { resourceId: ResourceId } | { path: string };

resources.at(path: string): Promise<ResourceHandle | null>;
resources.roots(page?: PageRequest): Promise<Page<ResourceHandle>>;
resources.search(filter: string, page?: PageRequest): Promise<Page<ResourceHandle>>;
resource.children(page?: PageRequest): Promise<Page<ResourceHandle>>;

grants.roots(page?: PageRequest): Promise<Page<GrantHandle>>;
grant.delegates(page?: PageRequest): Promise<Page<GrantHandle>>;
grant.lineage(): Promise<GrantHandle[]>;
grant.branch(page?: PageRequest): Promise<Page<GrantHandle>>;
grant.tokens.list(page?: PageRequest): Promise<Page<TokenHandle>>;
grant.delegable(target: CapabilityTarget): Promise<Permission[]>;

audit.list(page?: PageRequest): Promise<Page<AuditEvent>>;
```

A paged query takes a cursor and a limit and answers with its items and the cursor that continues them. Limits are bounded, so a caller that omits one still receives a page rather than a table. Resources and grants page in name order, and audit events page newest first. `lineage` is the one unpaged query, because a delegation chain is bounded by its depth and reading it whole is what makes downscoping legible.

A query answers with handles, so a listing row is a handle and an operation acts on it directly rather than resolving it again. A resource handle carries its path, its live child count, and the permissions its plane holds on it. A grant handle carries the number of grants delegated from it, its status within its lineage — `active`, `revoked`, `expired`, or `inactive ancestor` — and its capability entries, each paired with the path its target currently names and whether that target is live, empty, deleted, or missing. Resolution belongs to the answer because it is a fact about the current tree, and a caller holding one page has no tree of its own to resolve against.

`grant.delegable` answers what a delegating grant permits at one target, which is the bound a child grant's entries must respect. A form offers those permissions and marks an entry that asks for more; the domain check at issue remains authoritative.

`State` remains the shape of a store's seed and of browser persistence. It is not something a query answers with.

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

Each query is one `GET` of the record or collection it concerns:

```text
GET /resources                        the tree roots
GET /resources?path=acme/drive        the resource at one path
GET /resources?search=design          resources whose path matches a filter
GET /resources/:id
GET /resources/:id/children
GET /grants
GET /grants/:id
GET /grants/:id/delegates
GET /grants/:id/lineage
GET /grants/:id/branch
GET /grants/:id/tokens
GET /grants/:id/delegable?path=acme/drive
GET /tokens/:id
GET /audit
```

`cursor` and `limit` are query parameters on every paged route, and a page answers with its items and the cursor that continues them. Two queries take a bearer as their subject rather than as their credential: `authorize` is `POST /authorize` with `{ token, resourceId, permission }`, and `inspectToken` is `POST /authority` with `{ token }`. Both are posted because a secret belongs in a request body rather than in a URL.

Queries answer with plain serializable records, resolved paths, and page cursors, not handles. Persistence and the HTTP bodies stay JSON-compatible records and IDs; handles are the TypeScript surface over those calls. A handle method that returns a record returns an updated handle.

`authorize` and `inspectToken` remain repository queries about a presented bearer rather than methods on a token handle, because the caller often has only the secret, not a stored record.

Every command addresses resources by `ResourceId`. A resource path describes only where a resource currently sits, so resolving one is a query: `resources.at(path)` answers with the handle at that path or null, and the caller issues its command against the ID that handle carries. Resolution is a separate round trip from the command, so a command can never act on whatever happens to occupy a path at the moment it arrives. `normalizePath` stays a pure helper, because normalizing a path is a fact about the string rather than about the tree.

`@rgap/browser` implements `BrowserRgapStore` over local storage. It accepts initial state from its caller, so the package has no dependency on the reference application's example data.

`@rgap/react` provides an `RgapClient` that caches each query's most recent answer under a key derived from the query and its arguments, a client-local subscription, and the repository queries and commands run against. It also provides a client context plus hooks for a query's current answer, the same handle-based commands, and token-derived authority. After a command completes — including a method invoked on a handle the client returned — the client invalidates the cache, refetches the queries its subscribers currently hold, and notifies them. React components therefore stay current without requiring the repository or a remote backend to implement SSE, WebSockets, or another push protocol, and a refresh costs one bounded query per mounted view. The Vite application owns only its example seed, interface components, and styles.

The store contains resources, grants, token records, and audit events in normalized collections. Queries answer with that serializable application data; Zustand actions and other functions remain private to the adapter and never cross into domain operations. Each command computes and commits its complete state change atomically. Local persistence, when enabled, serializes the same application-state schema to browser storage. Stored state is loaded only when every ID it refers to resolves to a record; state that refers to resources, grants, or tokens it does not contain cannot be read at all, so it is discarded for the example seed rather than loaded into records that name things that are gone. Raw bearer-token values exist only in transient UI memory; persisted token records contain only token hashes.

The repository contract is asynchronous even though the browser implementation is local. Command inputs, query arguments, and query answers are JSON-compatible records, IDs, and cursors; handles are a TypeScript surface over those same calls. An HTTP-backed store implements the same plane selection, the same create-with-parentId routes, and the same queries, and can replace `BrowserRgapStore` without changing pages, components, or domain types. Live updates from changes made by other clients are optional client behavior. A client may refresh on demand, on window focus, or on an interval, and may add a streaming transport when an application specifically needs one. Backend-specific concerns such as transport, durable storage, concurrent transactions, authentication, and secret management remain outside the browser implementation.

The reference application does not expose a JSON API and is not a production authorization service. Browser state is appropriate for demonstrating the model, not for enforcing access between mutually untrusted parties.

## SQLite store

`@rgap/sqlite` implements `SqliteRgapStore` over a SQLite database with Drizzle ORM, so the model runs from ordinary TypeScript — a script, a test, or a service — against a real database rather than browser storage. It runs on `better-sqlite3`, whose synchronous API is what lets a command read, decide, and write inside one transaction.

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

A command is one SQLite transaction. It reads the complete state, applies the same pure `@rgap/core` rule the browser adapter applies, and replaces the stored rows with the state that rule returns. Nothing observes a partially updated authorization state, and a refused command writes nothing at all, because the rule rejects before the write begins.

Rows are written parents before children, so the foreign keys hold at every statement rather than only at the end of the transaction.

### Answering queries

A query is SQL against these tables rather than a filter over a loaded state. A resource's path and a grant's lineage are recursive walks up the parent column; a grant's branch and a resource's subtree are recursive walks down it. Resolving a path steps through `(parent_id, name)` one segment at a time. A page cursor is a keyset range over the ordering the query pages by, so answering a page reads the rows in that page rather than the rows before it.

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
