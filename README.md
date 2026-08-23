# RGAP

RGAP is an authorization model for filesystem-like resources, tools, and
agent-accessible services. It supports hierarchical delegation, strict
downscoping, immediate revocation, and predictable access across resource
moves and renames.

The model separates three concerns:

- **Resources** describe where objects live.
- **Grants** describe where authority comes from.
- **Tokens** are credentials used to exercise that authority.

```text
Resource tree                   Grant tree

acme/                           Company
├── platform/                   └── Platform team
│   ├── docs/                       └── Agent
│   └── tools/                          └── Sub-agent
└── finance/
```

A resource keeps the same stable identity when it moves. A grant carries one
or more resource entries over stable IDs or paths. A child grant can only
narrow its parent's resources, permissions, and expiration.

## Resources

Resources form a tree. Each record stores a stable ID, parent ID, single-segment
name, and deletion marker.

```ts
type Resource = {
  id: ResourceId;
  parentId: ResourceId | null;
  name: string;
  deletedAt: string | null;
};
```

A resource's ID names that object wherever it moves. Its path is derived by
joining ancestor names and its own name with `/`. Grant entries target either
an ID or a normalized path. An ID entry follows the object. A path entry stays
attached to the location.

### Create at a path

Create accepts a slash-separated location in `name`. The command walks that
path from the create parent, creates any missing live prefixes, and returns
the leaf.

```ts
const design = await admin.resources.create({
  name: 'acme/platform/docs/design',
});
```

`design.name` is `design`. `design.parentId` is the `docs` resource. The
derived path of `design` is `acme/platform/docs/design`.

A path is normalized the same way grant paths are: split on `/`, trim each
segment, and discard empty segments. `/acme/platform/docs/design/` and
`acme//platform/docs/design` name the same location. After normalization the
path must contain at least one segment.

Each stored resource name is one segment. Missing prefixes become ordinary
resources. Live prefixes are reused. The leaf must be absent: a second create
at an occupied path fails with `duplicate_path`.

Create is one state transition. Each newly created resource is audited as
`resource.create`. Each new resource receives a stable ID minted from its
segment name.

The same command creates a relative path under an existing resource:

```ts
const platform = await admin.resources.create({ name: 'acme/platform' });
const design = await platform.create({ name: 'docs/design' });
```

HTTP create uses the same `name` and an explicit `parentId`:

```json
{ "name": "acme/platform/docs/design", "parentId": null }
```

### Create authority

Creating a new root resource is administrative. Creating a child requires
`write` on that child's parent. Because `write` reaches a resource and its
current descendants, write on an ancestor authorizes creating deeper children.

`store.admin().resources.create` walks from the forest root and may create a
new root. `store.as(token).resources.create` also walks from the forest root:
it refuses a path that would create a new root, and it requires `write` on the
parent of every resource it creates. Existing prefixes need no additional
permission. `resource.create` requires `write` on that resource and then walks
the relative path beneath it.

## Grants and tokens

A grant contains resource entries and may delegate to child grants. Each entry
authorizes a permission set over a target and that target's current subtree.

```ts
type GrantResource =
  | { id: ResourceId; permissions: Permission[] }
  | { path: string; permissions: Permission[] };
```

A grant's identity, parent, and expiry are fixed at creation. Its resource set
is assigned afterwards and may start empty. A child grant cannot reach more
resources, gain permissions, or outlive its parent. The same downscoping proof
runs when a grant's resources are replaced; children the new set no longer
covers are revoked.

A token is an opaque bearer that selects a grant. The bearer is returned once;
storage keeps only its hash. Authorization evaluates the requested live
resource against every grant in the selected grant's ancestry. Revoking a token
disables that credential. Revoking a grant disables the grant, its tokens, and
every descendant grant.

`store.as(token)` returns a repository plane that authorizes each command
against that token. `store.admin()` returns an unrestricted plane for trusted
bootstrap.

## Packages

```text
packages/core      authorization rules, repository contract, command guard
packages/sqlite    durable SQLite store
apps/server        Hono HTTP API and generated clients
apps/docs          documentation site
examples           quickstart and scratchpad
```

```bash
pnpm install
pnpm test
pnpm --filter @rgap/examples exec tsx quickstart.ts
```
