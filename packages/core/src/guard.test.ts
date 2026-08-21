import { describe, expect, it } from 'vitest';
import type { Capability, State } from './domain';
import { fixture, stubRepository } from './fixture';
import { guardCommands } from './guard';

const at = '2026-08-22T00:00:00.000Z';
const bearer = 'b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3';
const subBearer = 'sub-token-hash';
const cap = (resourceId: string, permissions: Capability['permissions']): Capability =>
  ({ target: { type: 'resource', resourceId }, permissions, descendants: true });

/** The demo token references `coordinator`, which holds every permission across the drive subtree. */
function state(): State {
  const base = fixture();
  base.grants.coordinator.capabilities = [cap('drive', ['read', 'write', 'delete', 'move', 'invoke'])];
  base.grants.researcher.capabilities = [
    { target: { type: 'resource', resourceId: 'search-files' }, permissions: ['invoke'], descendants: false },
  ];
  // A grant tree beside the acting grant, which no token on the coordinator branch reaches.
  base.grants['other-root'] = {
    id: 'other-root', name: 'Other root', subject: 'other', parentId: null,
    capabilities: [], expiresAt: null, revokedAt: null,
  };
  base.grants.other = {
    id: 'other', name: 'Other', subject: 'other', parentId: 'other-root',
    capabilities: [], expiresAt: null, revokedAt: null,
  };
  // A second token on a delegated grant, which has a parent whose authority its holder cannot claim.
  base.tokens.sub = {
    id: 'sub', grantId: 'researcher', label: 'sub', hash: subBearer, expiresAt: null, revokedAt: null,
  };
  return base;
}

const guarded = (token = bearer) => {
  const { repository, calls } = stubRepository(state(), at);
  return { guard: guardCommands(repository, token), calls };
};

describe('command guard', () => {
  it('passes reads straight through', async () => {
    const { guard, calls } = guarded();

    expect(Object.keys((await guard.readState()).grants)).toContain('coordinator');
    expect((await guard.authorize(bearer, 'search-files', 'invoke')).allowed).toBe(true);
    expect((await guard.inspectToken(bearer)).grantId).toBe('coordinator');
    expect(calls).toEqual([]);
  });

  it('refuses every command to a token it cannot resolve to a grant', async () => {
    const { guard } = guarded('unknown-token');

    await expect(guard.createGrant({
      name: 'Child', subject: 'sub-agent', parentId: 'coordinator', capabilities: [], expiresAt: null,
    })).rejects.toThrow('Token is unknown, expired, or revoked.');
    await expect(guard.issueToken('coordinator', 'demo')).rejects.toThrow('Token is unknown, expired, or revoked.');
  });

  it('refuses the operations no token authorizes', async () => {
    const { guard, calls } = guarded();

    await expect(guard.createResource({
      name: 'root', parentId: null,
    })).rejects.toThrow('Creating a root resource is an administrative operation');
    await expect(guard.moveResource('drive', null)).rejects.toThrow('Moving a resource to a root is an administrative');
    await expect(guard.createGrant({
      name: 'Root', subject: 'agent', parentId: null, capabilities: [], expiresAt: null,
    })).rejects.toThrow('Creating a root grant is an administrative');
    await expect(guard.setCapabilities('coordinator', [])).rejects.toThrow("Setting a root grant's capabilities is an administrative");
    await expect(guard.reset()).rejects.toThrow('Resetting the store is an administrative');
    expect(calls).toEqual([]);
  });

  it('creates a resource only where the token holds write on the parent', async () => {
    const { guard, calls } = guarded();
    const input = { name: 'notes', parentId: 'drive' };

    expect((await guard.createResource(input)).id).toBe('created');
    expect(calls).toEqual([{ method: 'createResource', args: [input] }]);

    await expect(guard.createResource({ ...input, parentId: 'slack' }))
      .rejects.toThrow('No write capability survives the complete grant chain.');
  });

  it('moves a resource only with move on the resource and write on the destination', async () => {
    const { guard, calls } = guarded();

    expect((await guard.moveResource('search-files', 'read-file')).parentId).toBe('read-file');
    expect(calls).toEqual([{ method: 'moveResource', args: ['search-files', 'read-file'] }]);

    await expect(guard.moveResource('post-message', 'drive'))
      .rejects.toThrow('No move capability survives the complete grant chain.');
    await expect(guard.moveResource('search-files', 'slack'))
      .rejects.toThrow('No write capability survives the complete grant chain.');
  });

  it('deletes a resource only where the token holds delete on it', async () => {
    const { guard, calls } = guarded();

    await guard.deleteResource('read-file');
    expect(calls).toEqual([{ method: 'deleteResource', args: ['read-file'] }]);

    await expect(guard.deleteResource('post-message'))
      .rejects.toThrow('No delete capability survives the complete grant chain.');
  });

  it('delegates only from the grant its own token references', async () => {
    const { guard, calls } = guarded();
    const input = {
      name: 'Child', subject: 'sub-agent', parentId: 'coordinator', capabilities: [], expiresAt: null,
    };

    expect((await guard.createGrant(input)).id).toBe('created');
    expect(calls).toEqual([{ method: 'createGrant', args: [input] }]);

    await expect(guard.createGrant({ ...input, parentId: 'researcher' }))
      .rejects.toThrow('A token may only delegate from the grant it references.');
  });

  it('sets capabilities below its own grant, never on its own grant or beside it', async () => {
    const { guard, calls } = guarded();

    expect((await guard.setCapabilities('researcher', [])).capabilities).toEqual([]);
    expect(calls).toEqual([{ method: 'setCapabilities', args: ['researcher', []] }]);

    await expect(guard.setCapabilities('ghost', [])).rejects.toThrow('Grant does not exist.');
    await expect(guard.setCapabilities('other', []))
      .rejects.toThrow("That grant is neither this token's grant nor delegated from it.");
  });

  it('refuses to set the capabilities of the grant its own token references', async () => {
    const { guard, calls } = guarded(subBearer);

    await expect(guard.setCapabilities('researcher', []))
      .rejects.toThrow('A token may not set the capabilities of its own grant.');
    expect(calls).toEqual([]);
  });

  it('issues and revokes tokens only within its own grant branch', async () => {
    const { guard, calls } = guarded();

    expect((await guard.issueToken('researcher', 'sub')).value).toBe('issued-value');
    await guard.revokeToken('demo');
    expect(calls).toEqual([
      { method: 'issueToken', args: ['researcher', 'sub'] },
      { method: 'revokeToken', args: ['demo'] },
    ]);

    await expect(guard.issueToken('other', 'nope'))
      .rejects.toThrow("That grant is neither this token's grant nor delegated from it.");
    await expect(guard.revokeToken('ghost')).rejects.toThrow('Token does not exist.');
  });

  it('revokes a grant within its own branch, including its own grant', async () => {
    const { guard, calls } = guarded();

    await guard.revokeGrant('coordinator');
    await guard.revokeGrant('researcher');
    expect(calls.map((call) => call.args[0])).toEqual(['coordinator', 'researcher']);

    // A grant that resolves to no record walks to the top of nothing and reaches no acting grant.
    await expect(guard.revokeGrant('ghost'))
      .rejects.toThrow("That grant is neither this token's grant nor delegated from it.");
  });
});
