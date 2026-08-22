# Repository Implementation

The repository implements RGAP as framework-neutral TypeScript rules, a SQLite store, and an executable scratchpad:

```text
packages/
├── core/           # records, pure RGAP rules, RgapStore, and RgapRepository
└── sqlite/         # Drizzle and SQLite implementation
examples/
└── index.ts        # scratchpad run with pnpm scratch
```

## Core boundary

`@rgap/core` exports `RgapStore` and `RgapRepository`. A store exposes `as(token)` and `admin()` but no commands. Either method returns a repository whose collections mint and look up handles: `resources.create` mints a root, `grants.create` mints a root on the administrative plane and a child of the acting grant on a token plane, `resource.create` and `grant.create` mint children of that handle, and `grant.tokens.create` mints a token. `grant.capabilities.set` changes an existing grant.

Adapters implement an ID-based `RgapCommands` sink; `repositoryFrom` builds the handle surface. Every command addresses resources by stable ID. Path parsing, path rendering, and path resolution are pure helpers the caller applies first. The package also exports the domain records and pure rules and has no framework, persistence, or transport dependency.

`store.as(token)` returns a repository whose commands authorize the required permission before delegating and reject with the decision's explanation otherwise. `store.admin()` returns an unrestricted repository for trusted bootstrap and operations code. Plane selection is explicit, and the store itself has no command methods that application code can call accidentally. Token enforcement applies to commands only; `inspectToken` is the read-side authority lens.

The contract is asynchronous and JSON-compatible. An HTTP implementation can expose the same interface with ordinary request-response endpoints without changing the domain types.

## SQLite store

`@rgap/sqlite` exports `SqliteRgapStore`. It takes an optional database URL, a file path or `:memory:`, and an optional initial state, which initializes an empty database and supplies the state restored by `reset`.

`src/schema.ts` declares the tables, and `drizzle-kit generate` writes the DDL to `drizzle/`. The constructor applies that DDL to the database it opens. Each command runs in one `better-sqlite3` transaction: it reads the complete state, applies the relevant pure core rule, and replaces the stored rows with the resulting state. Rows are written parents before children so foreign keys hold after every statement.

The store contains normalized resources, grants, capability entries, token records, and audit events. Issued bearer values are returned once; persisted tokens contain only hashes. The package suite runs against `:memory:` databases, so it exercises real SQL and transactions.

## Scratchpad

`examples/index.ts` is the `@rgap/examples` workspace package. It consumes `@rgap/sqlite` and `@rgap/core` the same way an external TypeScript caller does. The file arranges resources and grants, exercises delegated command planes, and prints authorization decisions. It is a scratchpad rather than a fixture that another package depends on.

Pure domain rules enforce acyclic resources, capability containment, permission downscoping, parent-bounded expiration, target resolution, token status, current resource ancestry, and ancestor grant status. Deleted resources remain as tombstones, so path resolution, listings, authorization, and ID minting skip them while their IDs stay permanently taken.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm scratch
```

`pnpm build` type-checks every workspace package. `pnpm test` runs the core and SQLite suites. `pnpm scratch` executes `examples/index.ts` against a SQLite store.
