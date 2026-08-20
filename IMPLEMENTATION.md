# Reference Implementation

The repository is a minimal pnpm workspace with one framework-neutral RGAP contract package and one TanStack Start reference application. It contains no additional services or SDK packages.

```text
rgap/
├── apps/
│   └── web/
│       ├── drizzle/
│       ├── src/
│       │   ├── db/
│       │   │   ├── client.server.ts
│       │   │   ├── migrate.server.ts
│       │   │   └── schema.ts
│       │   ├── lib/rgap/
│       │   │   ├── drizzle-engine.server.ts
│       │   │   └── functions.ts
│       │   ├── routes/
│       │   │   ├── __root.tsx
│       │   │   ├── index.tsx
│       │   │   └── api.rgap.ts
│       │   ├── router.tsx
│       │   └── styles.css
│       ├── test/
│       ├── drizzle.config.ts
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts
├── packages/
│   └── rgap/
│       ├── src/
│       │   ├── engine.ts
│       │   ├── schemas.ts
│       │   └── index.ts
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.json
```

## RGAP contract package

The `packages/rgap` workspace publishes the framework-neutral `@rgap/core` package. It uses Zod as its only runtime dependency and exports the runtime schemas, inferred TypeScript types, structured error contract, and programmatic interface.

Every domain record and engine operation has an exported Zod schema. TypeScript types are inferred from those schemas rather than declared separately:

```typescript
export const createResourceInputSchema = z.strictObject({
  id: identifierSchema.optional(),
  parent_resource_id: identifierSchema.nullable(),
  name: z.string().min(1),
  type: z.string().min(1),
  move_policy: movePolicySchema.default('normal'),
  delete_policy: deletePolicySchema.default('revoke'),
});

export type CreateResourceInput = z.infer<
  typeof createResourceInputSchema
>;
```

The package exports schemas for:

- Resource, grant, capability, token, authorization-decision, and audit-event records
- Every `RgapEngine` method input and output
- Structured errors and validation issues
- The JSON API request and response envelopes
- A discriminated union of every supported operation
- A method registry that maps operation names to their input and output schemas

Schemas accept and return JSON-compatible values. Identifiers are non-empty opaque strings, timestamps are ISO 8601 strings, and capability constraints and audit metadata contain JSON values. Strict object schemas reject unknown fields at protocol boundaries.

The interface uses only schema-inferred types:

```typescript
interface RgapEngine {
  createResource(input: CreateResourceInput): Promise<Resource>;
  moveResource(input: MoveResourceInput): Promise<Resource>;

  createGrant(input: CreateGrantInput): Promise<Grant>;
  delegate(input: DelegateGrantInput): Promise<Grant>;

  issueToken(input: IssueTokenInput): Promise<IssuedToken>;
  authorize(input: AuthorizationRequest): Promise<AuthorizationDecision>;

  revokeToken(input: RevokeTokenInput): Promise<RevokeTokenOutput>;
  revokeGrant(input: RevokeGrantInput): Promise<RevokeGrantOutput>;
}
```

Revocation outputs are explicit JSON records rather than `void`, so every successful operation has a serializable and validatable result.

`@rgap/core` has no dependency on React, TanStack Start, Drizzle, PGlite, HTTP, or a specific storage system. It defines behavior and runtime validation without providing persistence or transport.

## TanStack Start application

The TanStack Start application imports `RgapEngine`, its schemas, and their inferred types from `@rgap/core`. Its server-only `DrizzleRgapEngine` implements every interface method using Drizzle and PGlite. Every method validates its input before executing and validates its output before returning. The dashboard, server functions, and JSON API depend only on `RgapEngine`; they do not reach into database tables directly. The implementation contains no placeholder or mock methods.

The engine owns validation of resource ancestry, capability containment, expiration, relocation policy, and hierarchical revocation. Grant authority fields are immutable after creation. Revocation metadata is mutable, and audit events record security-relevant changes.

### PGlite and Drizzle ORM

The application runs PGlite on the TanStack Start server and accesses it through Drizzle ORM's PGlite driver. The browser never opens the database or imports server-only database code.

The local database persists under `apps/web/.data/rgap` by default. `PGLITE_DATA_DIR` overrides that location. Tests create an isolated in-memory PGlite database for each test case.

Drizzle defines and migrates these tables:

- `resources`: stable ID, parent ID, name, type, and operation policies
- `grants`: parent grant, expiration, revocation metadata, and creation metadata
- `grant_capabilities`: grant ID, root resource, permissions, constraints, descendant policy, and relocation policy
- `tokens`: token hash, grant ID, expiration, and revocation metadata
- `audit_events`: actor, action, target, decision, timestamp, and structured metadata

The repository commits generated SQL migrations under `apps/web/drizzle`. Database scripts generate migrations, apply migrations, and open Drizzle Studio. Application startup applies committed migrations before serving engine operations.

Resource moves, delegation, token issuance, and grant revocation run inside database transactions. Authorization reads the current resource ancestry and complete grant ancestry from the same database state before returning a decision.

### Application interface

The application provides a small local dashboard for exercising and inspecting the model. The interface supports:

- Creating and moving resources
- Creating root grants and delegating child grants
- Issuing and revoking tokens
- Revoking a grant branch
- Simulating authorization requests
- Inspecting resource and grant trees
- Viewing decision explanations and audit events
- Loading the examples from [EXAMPLES.md](EXAMPLES.md)

TanStack Start server functions connect the dashboard to the server-only engine with schemas and inferred types from `@rgap/core`. A single server route at `/api/rgap` validates requests and responses with the exported envelope and operation schemas, exposing the same operation interface to local scripts and interoperability tests.

The route accepts a JSON request:

```json
{
  "id": "1",
  "method": "grant.delegate",
  "params": {
    "parent_grant_id": "grant_alice_alpha",
    "capabilities": [
      {
        "resource_id": "resource_alpha_docs",
        "permissions": ["read"]
      }
    ]
  }
}
```

It returns the request `id` with either `result` or a structured `error`:

```json
{
  "id": "1",
  "result": {
    "grant_id": "grant_bob_docs"
  }
}
```

The operation methods are:

```text
resource.create
resource.move
grant.create
grant.delegate
token.issue
authorize
token.revoke
grant.revoke
```

PGlite provides durable local state without requiring an external database server. Drizzle supplies the schema, queries, and transactions used by the engine.

The `RgapEngine` interface and domain contract stay independent from TanStack Start. The reference application implements the contract with Drizzle and PGlite behind that interface.

The application is a local protocol demonstrator, not a production authorization service. It does not expose administrative operations to an untrusted network or implement user authentication.

Both the resource tree and grant tree prevent cycles. Authorization checks current resource ancestry and every grant ancestor before returning an allow decision.
