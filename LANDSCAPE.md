# Authorization Landscape

RGAP defines transitive, attenuated delegation for users, agents, and sub-agents. It combines a mutable resource hierarchy, immutable grant lineage, opaque credentials, and strong online revocation.

The design occupies the space between decentralized capability tokens and centralized relationship-based authorization systems.

## The gap

Capability systems make delegation and attenuation natural, but decentralized verification makes immediate revocation and current resource-topology checks operationally difficult. Centralized authorization systems make revocation and mutable relationships natural, but they do not generally present agent-to-agent delegation, credential lineage, and attenuation as one native workflow.

RGAP combines:

```text
resource hierarchy
+ capability sets
+ delegation lineage
+ enforced attenuation
+ opaque agent credentials
+ cascading online revocation
+ transactional resource moves
```

No single system in this comparison makes RGAP's specific combination of provable capability containment, immediate ancestor revocation, and mutable-resource semantics its primary abstraction.

## Comparison

| System | Primary strength | Relationship to RGAP | Remaining gap |
| --- | --- | --- | --- |
| Macaroons | Bearer credentials with additive caveats | Establishes practical credential attenuation | Revocation and mutable resource state require external coordination |
| Biscuit | Offline attenuation and decentralized public-key verification | Closely matches downscoped bearer delegation | Revocation distribution remains external, and current topology still requires online state |
| UCAN | Signed delegation chains, provenance, attenuation, and revocation messages | Closely matches grant lineage and transitive delegation | Targets decentralized operation rather than strongly current centralized enforcement |
| Zanzibar | Globally consistent relationship-based authorization | Establishes scalable object and relationship evaluation | Does not define an agent-held capability exchange and attenuation lifecycle |
| OpenFGA | Open-source Zanzibar-style authorization with parent-child modeling | Models server, tool, folder, and document hierarchies | Delegation provenance, opaque credentials, and cascading grant semantics remain application concerns |
| SpiceDB | Relationship-based authorization with consistency controls, caveats, and expiration | Handles dynamic relationships and strongly controlled authorization freshness | Agent-to-agent attenuation and credential lineage require an application-level model |
| Cedar / Amazon Verified Permissions | Expressive policy evaluation over principals, actions, resources, and context | Provides a policy engine for individual decisions | Does not supply the complete credential delegation and descendant-revocation lifecycle |
| Keycard | Agent identity, MCP and A2A authorization, token exchange, credential brokering, policy, and audit | Closely matches the agent-facing use case and RFC 8693 delegation flow | Issued credentials survive grant revocation until expiration; strict capability containment and resource-move semantics are not protocol invariants |
| OAuth opaque tokens | Familiar, centrally introspected credentials | Matches RGAP's online token model and immediate revocation goals | OAuth scopes alone do not express resource trees or mandatory transitive attenuation |
| OAuth Token Exchange | Standard exchange flow for delegation and impersonation | Supplies a compatible wire pattern for parent-to-child credential exchange | Does not require output tokens to remain linked to input tokens or inherit revocation |

## Capability-token systems

### Macaroons

[Macaroons](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/) use chained message authentication codes and additive caveats. A holder can add restrictions without gaining authority. This directly informs RGAP's rule that delegation only narrows authority.

Macaroons carry their restrictions in the credential. RGAP instead keeps authoritative grant state online and uses an opaque token as a handle. This choice favors immediate revocation, auditability, and decisions based on current resource placement.

### Biscuit

[Biscuit](https://doc.biscuitsec.org/reference/specifications) is a bearer token with offline attenuation, decentralized verification, and a Datalog-based authorization language. Every appended block narrows the token and receives a revocation identifier.

Biscuit defines the identifiers needed to invalidate a token and its derivatives, but it leaves storage and distribution of revocations to the deployment. Its own [revocation guidance](https://www.biscuitsec.org/docs/guides/revocation/) describes polling, diff distribution, and queue-based propagation, each with an availability, latency, or operational tradeoff.

RGAP accepts an online authorization dependency. Every request can observe the authoritative grant ancestry and current resource tree, so a committed revocation or move affects subsequent strongly consistent checks.

### UCAN

[UCAN](https://github.com/ucan-wg/spec) defines signed, user-controlled delegation chains. Every direct delegation restates or attenuates authority, and the chain forms a provenance record. UCAN also defines revocation messages that invalidate downstream proofs.

UCAN is the closest semantic reference for transitive agent delegation. RGAP uses similar attenuation and provenance concepts while choosing opaque, stateful credentials and an online grant service as its default enforcement model.

## Relationship-based authorization

### Zanzibar, OpenFGA, and SpiceDB

[Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) establishes a scalable model for evaluating relationships between users and objects. [OpenFGA](https://openfga.dev/docs/modeling/parent-child) and [SpiceDB](https://authzed.com/docs/spicedb/concepts/schema) provide open-source systems inspired by this approach.

These systems naturally model relationships such as a document inheriting viewers from its parent folder or a tool belonging to an MCP server. Direct relationships stay attached to stable object identifiers while inherited access changes with containment.

An application can represent RGAP grants as objects and encode portions of the model in these systems. It still supplies token issuance, mandatory attenuation checks, delegation lineage, cascading grant revocation, resource-move transactions, and the agent-facing exchange protocol. RGAP makes those concerns the main abstraction rather than an application-specific schema.

### Cedar and Amazon Verified Permissions

[Cedar](https://www.cedarpolicy.com/) evaluates policies over a principal, action, resource, and request context. [Amazon Verified Permissions](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/what-is-avp.html) hosts Cedar policy stores and authorization decisions.

Cedar can express many RGAP decision rules, including resource hierarchy membership and contextual restrictions. RGAP additionally defines how authority is packaged, delegated, attenuated, revoked, and exercised by an agent chain.

## Agent authorization control planes

### Keycard

[Keycard](https://docs.keycard.ai/) is the closest product comparison to RGAP. It provides agent and workload identity, MCP authorization, agent-to-agent authorization, scoped credentials, policy enforcement, credential brokering, and centralized audit.

Keycard's [agent-to-agent SDK](https://docs.keycard.ai/sdk/agent-to-agent/) lets an agent exchange its incoming credential for a credential accepted by a downstream A2A agent while preserving the user's identity and authorization context. Its [credential issuance model](https://docs.keycard.ai/concepts/credentials/) uses RFC 8693 token exchange at each delegation hop and carries the complete actor chain for policy and audit.

The systems share several goals:

- A user authorizes an agent to act on the user's behalf
- Every agent has a distinct identity and audit attribution
- An agent obtains a narrower credential for a downstream resource or agent
- MCP and A2A calls pass through explicit authorization boundaries
- Upstream secrets do not enter the model context

The primary architectural difference is revocation. Keycard issues short-lived Keycard or provider credentials that resources can use without an online grant check. Its [grant revocation documentation](https://docs.keycard.ai/admin/revoke-a-grant/) states that revocation stops new credential issuance but does not invalidate credentials already issued.

RGAP uses an opaque credential as a handle to live grant state. The enforcement point checks the complete grant ancestry on every operation, so revoking an ancestor immediately denies every descendant credential after the revocation commits.

```text
Keycard
grant → short-lived credential → local resource verification
          revocation takes full effect as credentials expire

RGAP
grant → opaque handle → live ancestry check at enforcement
          ancestor revocation takes effect on the next check
```

Keycard evaluates policy during token exchange and scopes the resulting credential to a requested resource. RGAP additionally requires every child capability entry to be mechanically covered by a parent entry. Constraint types define deterministic containment rules, so delegation cannot expand authority even when an agent asks for it.

RGAP also makes mutable containment part of the authorization protocol. Moving a resource can remove inherited access, revoke a containment-derived grant, or reject the move. Keycard's public resource and delegation documentation does not define equivalent resource-move behavior as a protocol invariant.

Keycard is a production control plane with public integration SDKs. RGAP is a vendor-neutral protocol and a small reference implementation that another control plane, MCP gateway, or agent runtime can implement. The relevant RGAP contribution is not generic agent token exchange; it is revocation-linked, provably attenuated authority over mutable resource hierarchies.

## OAuth building blocks

RGAP aligns with OAuth where the standards already provide suitable protocol machinery.

### Token Exchange

[OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693) defines an HTTP and JSON security-token service that supports delegation and impersonation. Its `subject_token`, `actor_token`, `resource`, `audience`, and `scope` parameters provide a familiar basis for exchanging a parent credential for a child credential.

RFC 8693 intentionally leaves token semantics and trust models to deployments. An exchange does not inherently create a persistent link between its input and output tokens, and revocation propagation is not a general property of the protocol. An RGAP profile adds:

- A required parent-child grant link
- Strict capability-set attenuation
- Maximum child lifetime bounded by the parent
- Cascading ancestor revocation
- Stable resource identifiers and subtree semantics
- Auditable actor lineage

### Rich Authorization Requests

[OAuth 2.0 Rich Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9396) defines structured `authorization_details`. RGAP can use this mechanism to carry typed resource, action, and constraint requests when flat OAuth scope strings are insufficient.

### Proof of possession

[OAuth 2.0 DPoP](https://datatracker.ietf.org/doc/html/rfc9449) binds a token to a public key and reduces the value of a stolen bearer credential. RGAP supports opaque bearer tokens for simple deployments and recommends sender-constrained credentials for agents. An agent can use an ephemeral key for one execution and bind every delegated sub-agent credential to a different key.

## Fit with agent tool runtimes

Agent runtimes often hold broad user authorization while an individual execution needs only a small subset. A tool gateway can retain the user's provider credential and accept an RGAP credential from the agent:

```text
User provider credential
          ↓ stored in a protected vault
Tool gateway / MCP runtime
          ↑ presents narrow RGAP capability
Agent → sub-agent → sub-agent
```

The gateway validates the RGAP grant before retrieving the provider credential and invoking a tool. The agent never receives the upstream OAuth token or API key, so it cannot bypass RGAP and call the provider directly.

Arcade follows this general enforcement shape today: its documented tool authorization flow keeps provider tokens out of the LLM and client and injects them into the tool context at execution time. See [Arcade tool authorization](https://docs.arcade.dev/en/build/create-tools/tool-basics/create-tool-auth).

## Protocol direction

RGAP is best framed as an OAuth-compatible profile for transitive, attenuated agent delegation with strong online revocation. It standardizes semantics that OAuth Token Exchange leaves deployment-specific rather than defining a new transport for every operation.

The open project consists of:

```text
specification
├── capability and resource model
├── attenuation rules
├── delegation and revocation semantics
├── HTTP and OAuth profile
├── threat model
└── conformance requirements

reference implementation
├── framework-neutral Zod contract at packages/rgap
│   └── exported schemas, inferred types, and RgapEngine interface
├── TanStack Start application at apps/web
├── complete Drizzle implementation of RgapEngine
├── durable local PGlite database
├── local model explorer and decision simulator
├── typed server functions and one JSON API route
└── conformance tests and test vectors
```

The protocol remains vendor-neutral. Resource identifiers, issuer discovery, credentials, and conformance tests do not depend on an Arcade account. Arcade can act as one issuer and enforcement implementation while other tool gateways, agent runtimes, and resource servers interoperate with the same semantics.

## Design tradeoff

RGAP deliberately chooses strongly current authorization over fully offline verification:

```text
online grant state + current resource state
                    ↓
immediate hierarchical revocation and move-aware decisions
```

This creates an availability dependency on the authorization service or a cache with an explicitly bounded freshness policy. It also directly addresses the cases that decentralized credentials find hardest: urgent revocation, resource movement, policy changes, and complete delegation-chain auditing.
