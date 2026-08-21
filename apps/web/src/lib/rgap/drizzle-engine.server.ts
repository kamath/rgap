import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  authorizationDecisionSchema,
  authorizationRequestSchema,
  capabilitySchema,
  createGrantInputSchema,
  createGrantOutputSchema,
  createResourceInputSchema,
  createResourceOutputSchema,
  delegateGrantInputSchema,
  delegateGrantOutputSchema,
  issueTokenInputSchema,
  issueTokenOutputSchema,
  moveResourceInputSchema,
  moveResourceOutputSchema,
  revokeGrantInputSchema,
  revokeGrantOutputSchema,
  revokeTokenInputSchema,
  revokeTokenOutputSchema,
  RgapError,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type Capability,
  type CreateGrantInput,
  type CreateResourceInput,
  type DelegateGrantInput,
  type Grant,
  type IssuedToken,
  type IssueTokenInput,
  type JsonObject,
  type JsonValue,
  type MoveResourceInput,
  type Resource,
  type RevokeGrantInput,
  type RevokeGrantOutput,
  type RevokeTokenInput,
  type RevokeTokenOutput,
  type RgapEngine,
} from '@rgap/core'
import { and, eq, isNull } from 'drizzle-orm'

import type { RgapDatabase } from '../../db/client.server'
import {
  auditEvents,
  grantCapabilities,
  grants,
  resources,
  tokens,
} from '../../db/schema'

type RgapTransaction = Parameters<
  Parameters<RgapDatabase['transaction']>[0]
>[0]
type Executor = RgapDatabase | RgapTransaction

const relocationRank: Record<Capability['relocation_policy'], number> = {
  deny_move: 0,
  revoke_on_scope_exit: 1,
  follow_resource: 2,
}

function now() {
  return new Date().toISOString()
}

function identifier(prefix: string) {
  return `${prefix}_${randomUUID()}`
}

function isExpired(timestamp: string | null, evaluatedAt: string) {
  return timestamp !== null && Date.parse(timestamp) <= Date.parse(evaluatedAt)
}

function isoTimestamp(timestamp: string) {
  return new Date(timestamp).toISOString()
}

function nullableIsoTimestamp(timestamp: string | null) {
  return timestamp === null ? null : isoTimestamp(timestamp)
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]!))
    )
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => key in right && jsonEqual(left[key]!, right[key]!),
      )
    )
  }
  return false
}

function valueIsNarrower(narrower: JsonValue, broader: JsonValue): boolean {
  if (typeof narrower === 'number' && typeof broader === 'number') {
    return narrower <= broader
  }

  if (Array.isArray(narrower) && Array.isArray(broader)) {
    return narrower.every((candidate) =>
      broader.some((allowed) => jsonEqual(candidate, allowed)),
    )
  }

  if (
    narrower !== null &&
    broader !== null &&
    typeof narrower === 'object' &&
    typeof broader === 'object' &&
    !Array.isArray(narrower) &&
    !Array.isArray(broader)
  ) {
    return Object.entries(broader).every(
      ([key, allowed]) =>
        key in narrower && valueIsNarrower(narrower[key]!, allowed),
    )
  }

  return jsonEqual(narrower, broader)
}

function constraintsAreNarrower(
  narrower: JsonObject,
  broader: JsonObject,
): boolean {
  return Object.entries(broader).every(
    ([key, allowed]) =>
      key in narrower && valueIsNarrower(narrower[key]!, allowed),
  )
}

function mapResource(row: typeof resources.$inferSelect): Resource {
  return createResourceOutputSchema.parse({
    id: row.id,
    parent_resource_id: row.parentResourceId,
    name: row.name,
    type: row.type,
    move_policy: row.movePolicy,
    delete_policy: row.deletePolicy,
    created_at: isoTimestamp(row.createdAt),
    updated_at: isoTimestamp(row.updatedAt),
  })
}

function mapCapability(
  row: typeof grantCapabilities.$inferSelect,
): Capability {
  return capabilitySchema.parse({
    resource_id: row.resourceId,
    permissions: row.permissions,
    constraints: row.constraints,
    descendant_policy: row.descendantPolicy,
    relocation_policy: row.relocationPolicy,
  })
}

async function loadResource(executor: Executor, resourceId: string) {
  const [row] = await executor
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1)
  return row ? mapResource(row) : null
}

async function loadGrant(executor: Executor, grantId: string) {
  const [row] = await executor
    .select()
    .from(grants)
    .where(eq(grants.id, grantId))
    .limit(1)
  if (!row) return null

  const capabilityRows = await executor
    .select()
    .from(grantCapabilities)
    .where(eq(grantCapabilities.grantId, grantId))
    .orderBy(grantCapabilities.position)

  return createGrantOutputSchema.parse({
    id: row.id,
    parent_grant_id: row.parentGrantId,
    capabilities: capabilityRows.map(mapCapability),
    expires_at: nullableIsoTimestamp(row.expiresAt),
    revoked_at: nullableIsoTimestamp(row.revokedAt),
    created_by: row.createdBy,
    created_at: isoTimestamp(row.createdAt),
  })
}

async function grantLineage(executor: Executor, grantId: string) {
  const lineage: Grant[] = []
  const visited = new Set<string>()
  let currentId: string | null = grantId

  while (currentId) {
    if (visited.has(currentId)) {
      throw new RgapError('CONFLICT', 'grant ancestry contains a cycle', {
        grant_id: currentId,
      })
    }
    visited.add(currentId)
    const grant = await loadGrant(executor, currentId)
    if (!grant) {
      throw new RgapError('NOT_FOUND', 'grant does not exist', {
        grant_id: currentId,
      })
    }
    lineage.push(grant)
    currentId = grant.parent_grant_id
  }

  return lineage
}

async function resourceIsWithin(
  executor: Executor,
  candidateId: string,
  rootId: string,
) {
  const visited = new Set<string>()
  let currentId: string | null = candidateId

  while (currentId) {
    if (currentId === rootId) return true
    if (visited.has(currentId)) return false
    visited.add(currentId)
    const resource = await loadResource(executor, currentId)
    if (!resource) return false
    currentId = resource.parent_resource_id
  }

  return false
}

async function capabilityCovers(
  executor: Executor,
  broader: Capability,
  narrower: Capability,
) {
  const resourceCovered =
    broader.resource_id === narrower.resource_id ||
    (broader.descendant_policy === 'include' &&
      (await resourceIsWithin(
        executor,
        narrower.resource_id,
        broader.resource_id,
      )))

  if (!resourceCovered) return false
  if (
    broader.descendant_policy === 'exclude' &&
    narrower.descendant_policy === 'include'
  ) {
    return false
  }
  if (
    !narrower.permissions.every((permission) =>
      broader.permissions.includes(permission),
    )
  ) {
    return false
  }
  if (
    relocationRank[narrower.relocation_policy] >
    relocationRank[broader.relocation_policy]
  ) {
    return false
  }

  return constraintsAreNarrower(narrower.constraints, broader.constraints)
}

async function capabilityAppliesToResource(
  executor: Executor,
  capability: Capability,
  resourceId: string,
) {
  return (
    capability.resource_id === resourceId ||
    (capability.descendant_policy === 'include' &&
      (await resourceIsWithin(
        executor,
        resourceId,
        capability.resource_id,
      )))
  )
}

async function insertCapabilities(
  executor: Executor,
  grantId: string,
  capabilities: Capability[],
) {
  await executor.insert(grantCapabilities).values(
    capabilities.map((capability, index) => ({
      grantId,
      position: index.toString().padStart(6, '0'),
      resourceId: capability.resource_id,
      permissions: capability.permissions,
      constraints: capability.constraints,
      descendantPolicy: capability.descendant_policy,
      relocationPolicy: capability.relocation_policy,
    })),
  )
}

async function insertAudit(
  executor: Executor,
  input: {
    actor?: string | null
    action: string
    target?: string | null
    decision?: 'allow' | 'deny' | null
    metadata?: JsonObject
    createdAt?: string
  },
) {
  await executor.insert(auditEvents).values({
    id: identifier('audit'),
    actor: input.actor ?? null,
    action: input.action,
    target: input.target ?? null,
    decision: input.decision ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? now(),
  })
}

function ensureLineageActive(lineage: Grant[], evaluatedAt: string) {
  for (const [index, grant] of lineage.entries()) {
    if (grant.revoked_at) {
      throw new RgapError('REVOKED', 'grant ancestry contains a revoked grant', {
        grant_id: grant.id,
        relationship: index === 0 ? 'selected' : 'ancestor',
      })
    }
    if (isExpired(grant.expires_at, evaluatedAt)) {
      throw new RgapError('EXPIRED', 'grant ancestry contains an expired grant', {
        grant_id: grant.id,
        relationship: index === 0 ? 'selected' : 'ancestor',
      })
    }
  }
}

export class DrizzleRgapEngine implements RgapEngine {
  constructor(private readonly database: RgapDatabase) {}

  async createResource(input: CreateResourceInput): Promise<Resource> {
    const parsed = createResourceInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      if (
        parsed.parent_resource_id &&
        !(await loadResource(transaction, parsed.parent_resource_id))
      ) {
        throw new RgapError('NOT_FOUND', 'parent resource does not exist', {
          parent_resource_id: parsed.parent_resource_id,
        })
      }

      const timestamp = now()
      const id = parsed.id ?? identifier('resource')
      await transaction.insert(resources).values({
        id,
        parentResourceId: parsed.parent_resource_id,
        name: parsed.name,
        type: parsed.type,
        movePolicy: parsed.move_policy,
        deletePolicy: parsed.delete_policy,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      await insertAudit(transaction, {
        action: 'resource.create',
        target: id,
        createdAt: timestamp,
      })

      const resource = await loadResource(transaction, id)
      if (!resource) throw new RgapError('INTERNAL_ERROR', 'resource insert failed')
      return createResourceOutputSchema.parse(resource)
    })
  }

  async moveResource(input: MoveResourceInput): Promise<Resource> {
    const parsed = moveResourceInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const resource = await loadResource(transaction, parsed.resource_id)
      if (!resource) {
        throw new RgapError('NOT_FOUND', 'resource does not exist', {
          resource_id: parsed.resource_id,
        })
      }

      if (parsed.new_parent_resource_id === parsed.resource_id) {
        throw new RgapError('CONFLICT', 'a resource cannot contain itself')
      }
      if (parsed.new_parent_resource_id) {
        const parent = await loadResource(
          transaction,
          parsed.new_parent_resource_id,
        )
        if (!parent) {
          throw new RgapError('NOT_FOUND', 'new parent resource does not exist', {
            parent_resource_id: parsed.new_parent_resource_id,
          })
        }
        if (
          await resourceIsWithin(
            transaction,
            parsed.new_parent_resource_id,
            parsed.resource_id,
          )
        ) {
          throw new RgapError(
            'CONFLICT',
            'resource move would create a cycle',
          )
        }
      }

      if (resource.move_policy === 'deny_while_granted') {
        const activeCapability = await transaction
          .select({ grantId: grantCapabilities.grantId })
          .from(grantCapabilities)
          .innerJoin(grants, eq(grants.id, grantCapabilities.grantId))
          .where(
            and(
              eq(grantCapabilities.resourceId, parsed.resource_id),
              isNull(grants.revokedAt),
            ),
          )
          .limit(1)
        if (activeCapability.length > 0) {
          throw new RgapError(
            'MOVE_DENIED',
            'resource denies moves while active grants exist',
            { resource_id: parsed.resource_id },
          )
        }
      }

      const timestamp = now()
      await transaction
        .update(resources)
        .set({
          parentResourceId: parsed.new_parent_resource_id,
          updatedAt: timestamp,
        })
        .where(eq(resources.id, parsed.resource_id))

      const delegatedGrantRows = await transaction
        .select()
        .from(grants)
        .where(and(isNull(grants.revokedAt)))

      for (const grantRow of delegatedGrantRows) {
        if (!grantRow.parentGrantId) continue
        const child = await loadGrant(transaction, grantRow.id)
        const parent = await loadGrant(transaction, grantRow.parentGrantId)
        if (!child || !parent) continue

        let revokeGrant = false
        for (const childCapability of child.capabilities) {
          const stillCovered = await Promise.all(
            parent.capabilities.map((parentCapability) =>
              capabilityCovers(
                transaction,
                parentCapability,
                childCapability,
              ),
            ),
          )
          if (stillCovered.some(Boolean)) continue

          if (childCapability.relocation_policy === 'deny_move') {
            throw new RgapError(
              'MOVE_DENIED',
              'an active delegated grant denies this move',
              { grant_id: child.id, resource_id: childCapability.resource_id },
            )
          }
          if (
            childCapability.relocation_policy === 'revoke_on_scope_exit'
          ) {
            revokeGrant = true
          }
        }

        if (revokeGrant) {
          await transaction
            .update(grants)
            .set({ revokedAt: timestamp })
            .where(eq(grants.id, child.id))
          await insertAudit(transaction, {
            actor: parsed.actor,
            action: 'grant.revoke_on_scope_exit',
            target: child.id,
            metadata: { moved_resource_id: parsed.resource_id },
            createdAt: timestamp,
          })
        }
      }

      await insertAudit(transaction, {
        actor: parsed.actor,
        action: 'resource.move',
        target: parsed.resource_id,
        metadata: { new_parent_resource_id: parsed.new_parent_resource_id },
        createdAt: timestamp,
      })

      const moved = await loadResource(transaction, parsed.resource_id)
      if (!moved) throw new RgapError('INTERNAL_ERROR', 'resource move failed')
      return moveResourceOutputSchema.parse(moved)
    })
  }

  async createGrant(input: CreateGrantInput): Promise<Grant> {
    const parsed = createGrantInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      for (const capability of parsed.capabilities) {
        if (!(await loadResource(transaction, capability.resource_id))) {
          throw new RgapError('NOT_FOUND', 'capability resource does not exist', {
            resource_id: capability.resource_id,
          })
        }
      }

      const timestamp = now()
      const id = parsed.id ?? identifier('grant')
      await transaction.insert(grants).values({
        id,
        parentGrantId: null,
        expiresAt: parsed.expires_at,
        revokedAt: null,
        createdBy: parsed.created_by,
        createdAt: timestamp,
      })
      await insertCapabilities(transaction, id, parsed.capabilities)
      await insertAudit(transaction, {
        actor: parsed.created_by,
        action: 'grant.create',
        target: id,
        createdAt: timestamp,
      })

      const grant = await loadGrant(transaction, id)
      if (!grant) throw new RgapError('INTERNAL_ERROR', 'grant insert failed')
      return createGrantOutputSchema.parse(grant)
    })
  }

  async delegate(input: DelegateGrantInput): Promise<Grant> {
    const parsed = delegateGrantInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const evaluatedAt = now()
      const lineage = await grantLineage(transaction, parsed.parent_grant_id)
      ensureLineageActive(lineage, evaluatedAt)
      const parent = lineage[0]!

      if (
        parent.expires_at &&
        (!parsed.expires_at ||
          Date.parse(parsed.expires_at) > Date.parse(parent.expires_at))
      ) {
        throw new RgapError(
          'AUTHORITY_EXPANSION',
          'child expiration exceeds parent expiration',
        )
      }

      for (const capability of parsed.capabilities) {
        if (!(await loadResource(transaction, capability.resource_id))) {
          throw new RgapError('NOT_FOUND', 'capability resource does not exist', {
            resource_id: capability.resource_id,
          })
        }
        const coverage = await Promise.all(
          parent.capabilities.map((parentCapability) =>
            capabilityCovers(transaction, parentCapability, capability),
          ),
        )
        if (!coverage.some(Boolean)) {
          throw new RgapError(
            'AUTHORITY_EXPANSION',
            'child capability is not covered by its parent grant',
            { resource_id: capability.resource_id },
          )
        }
      }

      const id = parsed.id ?? identifier('grant')
      await transaction.insert(grants).values({
        id,
        parentGrantId: parent.id,
        expiresAt: parsed.expires_at,
        revokedAt: null,
        createdBy: parsed.created_by,
        createdAt: evaluatedAt,
      })
      await insertCapabilities(transaction, id, parsed.capabilities)
      await insertAudit(transaction, {
        actor: parsed.created_by,
        action: 'grant.delegate',
        target: id,
        metadata: { parent_grant_id: parent.id },
        createdAt: evaluatedAt,
      })

      const grant = await loadGrant(transaction, id)
      if (!grant) throw new RgapError('INTERNAL_ERROR', 'grant insert failed')
      return delegateGrantOutputSchema.parse(grant)
    })
  }

  async issueToken(input: IssueTokenInput): Promise<IssuedToken> {
    const parsed = issueTokenInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const timestamp = now()
      const lineage = await grantLineage(transaction, parsed.grant_id)
      ensureLineageActive(lineage, timestamp)
      const selectedGrant = lineage[0]!

      if (
        selectedGrant.expires_at &&
        (!parsed.expires_at ||
          Date.parse(parsed.expires_at) > Date.parse(selectedGrant.expires_at))
      ) {
        throw new RgapError(
          'AUTHORITY_EXPANSION',
          'token expiration exceeds grant expiration',
        )
      }

      const secret = `rgap_${randomBytes(32).toString('base64url')}`
      const id = parsed.id ?? identifier('token')
      const prefix = secret.slice(0, 12)
      await transaction.insert(tokens).values({
        id,
        grantId: selectedGrant.id,
        tokenHash: tokenHash(secret),
        tokenPrefix: prefix,
        expiresAt: parsed.expires_at,
        revokedAt: null,
        createdAt: timestamp,
      })
      await insertAudit(transaction, {
        actor: parsed.actor,
        action: 'token.issue',
        target: id,
        metadata: { grant_id: selectedGrant.id },
        createdAt: timestamp,
      })

      return issueTokenOutputSchema.parse({
        token: secret,
        token_record: {
          id,
          grant_id: selectedGrant.id,
          token_prefix: prefix,
          expires_at: parsed.expires_at,
          revoked_at: null,
          created_at: timestamp,
        },
      })
    })
  }

  async authorize(input: AuthorizationRequest): Promise<AuthorizationDecision> {
    const parsed = authorizationRequestSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const evaluatedAt = now()
      const deny = async (
        reason: AuthorizationDecision['reason'],
        options: Partial<
          Pick<
            AuthorizationDecision,
            'grant_id' | 'matched_capability' | 'grant_lineage'
          >
        > = {},
      ) => {
        const decision = authorizationDecisionSchema.parse({
          allowed: false,
          reason,
          grant_id: options.grant_id ?? null,
          matched_capability: options.matched_capability ?? null,
          grant_lineage: options.grant_lineage ?? [],
          evaluated_at: evaluatedAt,
        })
        await insertAudit(transaction, {
          action: 'authorize',
          target: parsed.resource_id,
          decision: 'deny',
          metadata: { permission: parsed.permission, reason },
          createdAt: evaluatedAt,
        })
        return decision
      }

      const [tokenRow] = await transaction
        .select()
        .from(tokens)
        .where(eq(tokens.tokenHash, tokenHash(parsed.token)))
        .limit(1)
      if (!tokenRow) return deny('token_invalid')
      if (tokenRow.revokedAt) return deny('token_revoked')
      if (isExpired(tokenRow.expiresAt, evaluatedAt)) {
        return deny('token_expired')
      }

      const lineage = await grantLineage(transaction, tokenRow.grantId)
      const lineageIds = [...lineage].reverse().map((grant) => grant.id)
      for (const [index, grant] of lineage.entries()) {
        if (grant.revoked_at) {
          return deny(index === 0 ? 'grant_revoked' : 'ancestor_revoked', {
            grant_id: lineage[0]!.id,
            grant_lineage: lineageIds,
          })
        }
        if (isExpired(grant.expires_at, evaluatedAt)) {
          return deny(index === 0 ? 'grant_expired' : 'ancestor_expired', {
            grant_id: lineage[0]!.id,
            grant_lineage: lineageIds,
          })
        }
      }

      if (!(await loadResource(transaction, parsed.resource_id))) {
        return deny('resource_not_found', {
          grant_id: lineage[0]!.id,
          grant_lineage: lineageIds,
        })
      }

      const selectedGrant = lineage[0]!
      const scopedCapabilities: Capability[] = []
      const permittedCapabilities: Capability[] = []
      for (const capability of selectedGrant.capabilities) {
        if (
          await capabilityAppliesToResource(
            transaction,
            capability,
            parsed.resource_id,
          )
        ) {
          scopedCapabilities.push(capability)
          if (capability.permissions.includes(parsed.permission)) {
            permittedCapabilities.push(capability)
          }
        }
      }

      if (scopedCapabilities.length === 0) {
        return deny('capability_not_found', {
          grant_id: selectedGrant.id,
          grant_lineage: lineageIds,
        })
      }
      if (permittedCapabilities.length === 0) {
        return deny('permission_denied', {
          grant_id: selectedGrant.id,
          grant_lineage: lineageIds,
        })
      }

      const matched = permittedCapabilities.find((capability) =>
        constraintsAreNarrower(parsed.constraints, capability.constraints),
      )
      if (!matched) {
        return deny('constraints_not_satisfied', {
          grant_id: selectedGrant.id,
          grant_lineage: lineageIds,
        })
      }

      const decision = authorizationDecisionSchema.parse({
        allowed: true,
        reason: 'allowed',
        grant_id: selectedGrant.id,
        matched_capability: matched,
        grant_lineage: lineageIds,
        evaluated_at: evaluatedAt,
      })
      await insertAudit(transaction, {
        action: 'authorize',
        target: parsed.resource_id,
        decision: 'allow',
        metadata: { permission: parsed.permission, grant_id: selectedGrant.id },
        createdAt: evaluatedAt,
      })
      return decision
    })
  }

  async revokeToken(input: RevokeTokenInput): Promise<RevokeTokenOutput> {
    const parsed = revokeTokenInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const [token] = await transaction
        .select()
        .from(tokens)
        .where(eq(tokens.id, parsed.token_id))
        .limit(1)
      if (!token) {
        throw new RgapError('NOT_FOUND', 'token does not exist', {
          token_id: parsed.token_id,
        })
      }

      const revokedAt = token.revokedAt ? isoTimestamp(token.revokedAt) : now()
      if (!token.revokedAt) {
        await transaction
          .update(tokens)
          .set({ revokedAt })
          .where(eq(tokens.id, token.id))
        await insertAudit(transaction, {
          actor: parsed.actor,
          action: 'token.revoke',
          target: token.id,
          createdAt: revokedAt,
        })
      }

      return revokeTokenOutputSchema.parse({
        token_id: token.id,
        revoked: true,
        revoked_at: revokedAt,
      })
    })
  }

  async revokeGrant(input: RevokeGrantInput): Promise<RevokeGrantOutput> {
    const parsed = revokeGrantInputSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const grant = await loadGrant(transaction, parsed.grant_id)
      if (!grant) {
        throw new RgapError('NOT_FOUND', 'grant does not exist', {
          grant_id: parsed.grant_id,
        })
      }

      const revokedAt = grant.revoked_at ?? now()
      if (!grant.revoked_at) {
        await transaction
          .update(grants)
          .set({ revokedAt })
          .where(eq(grants.id, grant.id))
        await insertAudit(transaction, {
          actor: parsed.actor,
          action: 'grant.revoke',
          target: grant.id,
          createdAt: revokedAt,
        })
      }

      return revokeGrantOutputSchema.parse({
        grant_id: grant.id,
        revoked: true,
        revoked_at: revokedAt,
      })
    })
  }
}
