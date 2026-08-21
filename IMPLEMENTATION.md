# Reference Implementation

The repository contains one regular React and TypeScript Vite application at `apps/frontend`. It runs entirely in the browser and uses Zustand for device-local state.

The implementation is an interface test bed. It favors short files, direct control flow, explicit data shapes, and a plain functional UI over production infrastructure or visual polish.

```text
apps/frontend/src/
├── domain.ts       # records and pure RGAP rules
├── repository.ts   # async contract and browser implementation
├── seed.ts         # deterministic example state
├── App.tsx         # plain interface for every operation
├── main.tsx
└── styles.css
```

## Boundary under test

React depends on `RgapRepository`, which exposes a snapshot subscription and asynchronous methods for every query and command. Components never access Zustand directly.

```text
React UI → RgapRepository → BrowserRgapRepository → Zustand + localStorage
```

The contract stays asynchronous and JSON-compatible even though its browser implementation is local. A future `HttpRgapRepository` can implement the same interface without changing the UI or domain record shapes.

`BrowserRgapRepository` owns the Zustand store. Each command calls a pure domain function that returns one complete next state, then commits that state once. Browser persistence serializes normalized resources, grants, token records, and audit events. Issued bearer values are returned once; persisted tokens contain only hashes.

## Supported operations

The interface exposes all repository methods without extra workflow abstractions:

- Create a resource by name and parent path, creating missing resource segments atomically
- Select move and delete policies during resource creation
- Move a resource to an existing path or delete its subtree
- Create a root grant or delegate from a parent grant
- Issue, activate, paste, clear, or revoke a token
- Revoke a grant branch
- Authorize a token for a resource and permission
- Reset to the deterministic MCP example

The resource tree shows paths using names while the domain continues to reference stable IDs. A shared active-token lens derives effective resource permissions and grant lineage. Blank selects the complete administrative view; a valid token narrows the tree; an invalid or inactive token exposes no authority.

Pure domain rules enforce acyclic resources, capability containment, permission downscoping, parent-bounded expiration, relocation policy, token status, current resource ancestry, and ancestor grant status.

The application is a browser-only model explorer, not a security boundary. A production adapter places the repository behind authenticated transport, durable storage, and transactional concurrency control.

## Run

```bash
pnpm install
pnpm dev
```

Use `pnpm build` for a production bundle and `pnpm test` for the domain tests.
