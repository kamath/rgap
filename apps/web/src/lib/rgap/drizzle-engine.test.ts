import { describe, expect, it } from 'vitest'

import { createMemoryDatabase } from '../../db/client.server'
import { DrizzleRgapEngine } from './drizzle-engine.server'

async function fixture() {
  const engine = new DrizzleRgapEngine(await createMemoryDatabase())
  await engine.createResource({
    id: 'project',
    name: 'Project',
    type: 'folder',
  })
  await engine.createResource({
    id: 'docs',
    parent_resource_id: 'project',
    name: 'Docs',
    type: 'folder',
  })
  await engine.createResource({
    id: 'design',
    parent_resource_id: 'docs',
    name: 'Design',
    type: 'file',
  })
  await engine.createResource({
    id: 'private',
    name: 'Private',
    type: 'folder',
  })
  await engine.createGrant({
    id: 'alice',
    created_by: 'alice',
    capabilities: [{
      resource_id: 'project',
      permissions: ['read', 'write'],
      descendant_policy: 'include',
      relocation_policy: 'follow_resource',
    }],
  })
  return engine
}

describe('DrizzleRgapEngine', () => {
  it('delegates only narrower authority and authorizes descendants', async () => {
    const engine = await fixture()
    await engine.delegate({
      id: 'bob',
      parent_grant_id: 'alice',
      created_by: 'bob',
      capabilities: [{
        resource_id: 'docs',
        permissions: ['read'],
        descendant_policy: 'include',
      }],
    })

    await expect(engine.delegate({
      parent_grant_id: 'bob',
      capabilities: [{ resource_id: 'docs', permissions: ['write'] }],
    })).rejects.toMatchObject({ code: 'AUTHORITY_EXPANSION' })

    const issued = await engine.issueToken({ grant_id: 'bob' })
    await expect(engine.authorize({
      token: issued.token,
      resource_id: 'design',
      permission: 'read',
    })).resolves.toMatchObject({ allowed: true, grant_lineage: ['alice', 'bob'] })
    await expect(engine.authorize({
      token: issued.token,
      resource_id: 'design',
      permission: 'write',
    })).resolves.toMatchObject({ allowed: false, reason: 'permission_denied' })
  })

  it('makes ancestor revocation effective without rewriting descendants', async () => {
    const engine = await fixture()
    await engine.delegate({
      id: 'bob',
      parent_grant_id: 'alice',
      capabilities: [{ resource_id: 'docs', permissions: ['read'] }],
    })
    const issued = await engine.issueToken({ grant_id: 'bob' })
    await engine.revokeGrant({ grant_id: 'alice' })

    await expect(engine.authorize({
      token: issued.token,
      resource_id: 'docs',
      permission: 'read',
    })).resolves.toMatchObject({ allowed: false, reason: 'ancestor_revoked' })
  })

  it('revokes a direct grant when its resource leaves delegated scope', async () => {
    const engine = await fixture()
    await engine.delegate({
      id: 'bob',
      parent_grant_id: 'alice',
      capabilities: [{
        resource_id: 'design',
        permissions: ['read'],
        relocation_policy: 'revoke_on_scope_exit',
      }],
    })
    const issued = await engine.issueToken({ grant_id: 'bob' })
    await engine.moveResource({ resource_id: 'design', new_parent_resource_id: 'private' })

    await expect(engine.authorize({
      token: issued.token,
      resource_id: 'design',
      permission: 'read',
    })).resolves.toMatchObject({ allowed: false, reason: 'grant_revoked' })
  })
})
