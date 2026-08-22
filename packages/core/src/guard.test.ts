import { describe, expect, it } from 'vitest';
import { grantId, resourceId, tokenHash, tokenId, tokenValue, type Capability, type State } from './domain';
import { fixture, stubCommands } from './fixture';
import { guardCommands } from './guard';
import { repositoryFrom } from './repository';

const at = '2026-08-22T00:00:00.000Z';
const bearer = tokenValue('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');
const subBearer = tokenValue('sub-token-hash');
const r = resourceId;
const g = grantId;
const cap = (id: string, permissions: Capability['permissions']): Capability =>
  ({ target: { type: 'resource', resourceId: r(id) }, permissions, descendants: true });

/** The demo token references `coordinator`, which holds every permission across the drive subtree. */
function state(): State {
  const base = fixture();
  base.grants.coordinator.capabilities = [cap('drive', ['read', 'write', 'delete', 'move', 'invoke'])];
  base.grants.researcher.capabilities = [
    { target: { type: 'resource', resourceId: r('search-files') }, permissions: ['invoke'], descendants: false },
  ];
  // A grant tree beside the acting grant, which no token on the coordinator branch reaches.
  base.grants['other-root'] = {
    id: g('other-root'), name: 'Other root', parentId: null,
    capabilities: [], expiresAt: null, revokedAt: null,
  };
  base.grants.other = {
    id: g('other'), name: 'Other', parentId: g('other-root'),
    capabilities: [], expiresAt: null, revokedAt: null,
  };
  // A second token on a delegated grant, which has a parent whose authority its holder cannot claim.
  base.tokens.sub = {
    id: tokenId('sub'), grantId: g('researcher'), label: 'sub', hash: tokenHash('sub-token-hash'), expiresAt: null, revokedAt: null,
  };
  return base;
}

const guarded = (token = bearer) => {
  const { commands, calls } = stubCommands(state(), at);
  return { guard: guardCommands(repositoryFrom(commands), token), calls };
};

describe('command guard', () => {
  it('passes reads straight through', async () => {
    const { guard, calls } = guarded();

    expect(Object.keys((await guard.readState()).grants)).toContain('coordinator');
    expect((await guard.authorize(bearer, r('search-files'), 'invoke')).allowed).toBe(true);
    expect((await guard.inspectToken(bearer)).grantId).toBe('coordinator');
    expect(calls).toEqual([]);
  });

  it('refuses every command to a token it cannot resolve to a grant', async () => {
    const { guard } = guarded(tokenValue('unknown-token'));
    const grant = await guard.grants.get(g('coordinator'));

    await expect(grant.create({
      name: 'Child', capabilities: [], expiresAt: null,
    })).rejects.toThrow('Token is unknown, expired, or revoked.');
    await expect(grant.tokens.create({ label: 'demo' })).rejects.toThrow('Token is unknown, expired, or revoked.');
  });

  it('refuses the operations no token authorizes', async () => {
    const { guard, calls } = guarded();
    const drive = await guard.resources.get(r('drive'));

    await expect(guard.resources.create({ name: 'root' }))
      .rejects.toThrow('Creating a root resource is an administrative operation');
    await expect(drive.move(null)).rejects.toThrow('Moving a resource to a root is an administrative');
    await expect(guard.grants.create({
      name: 'Root', capabilities: [], expiresAt: null,
    })).rejects.toThrow('Creating a root grant is an administrative');
    await expect((await guard.grants.get(g('coordinator'))).capabilities.set([]))
      .rejects.toThrow("Setting a root grant's capabilities is an administrative");
    await expect(guard.reset()).rejects.toThrow('Resetting the store is an administrative');
    expect(calls).toEqual([]);
  });

  it('creates a resource only where the token holds write on the parent', async () => {
    const { guard, calls } = guarded();
    const drive = await guard.resources.get(r('drive'));

    expect((await drive.create({ name: 'notes' })).id).toBe('created');
    expect(calls).toEqual([{ method: 'createResource', args: [{ name: 'notes', parentId: r('drive') }] }]);

    await expect((await guard.resources.get(r('slack'))).create({ name: 'notes' }))
      .rejects.toThrow('No write capability survives the complete grant chain.');
  });

  it('moves a resource only with move on the resource and write on the destination', async () => {
    const { guard, calls } = guarded();
    const search = await guard.resources.get(r('search-files'));

    expect((await search.move(r('read-file'))).parentId).toBe('read-file');
    expect(calls).toEqual([{ method: 'moveResource', args: [r('search-files'), r('read-file')] }]);

    await expect((await guard.resources.get(r('post-message'))).move(r('drive')))
      .rejects.toThrow('No move capability survives the complete grant chain.');
    await expect((await guard.resources.get(r('search-files'))).move(r('slack')))
      .rejects.toThrow('No write capability survives the complete grant chain.');
  });

  it('deletes a resource only where the token holds delete on it', async () => {
    const { guard, calls } = guarded();

    await (await guard.resources.get(r('read-file'))).delete();
    expect(calls).toEqual([{ method: 'deleteResource', args: [r('read-file')] }]);

    await expect((await guard.resources.get(r('post-message'))).delete())
      .rejects.toThrow('No delete capability survives the complete grant chain.');
  });

  it('delegates only from the grant its own token references', async () => {
    const { guard, calls } = guarded();
    const input = { name: 'Child', capabilities: [], expiresAt: null };

    expect((await (await guard.grants.get(g('coordinator'))).create(input)).id).toBe('created');
    expect(calls).toEqual([{ method: 'createGrant', args: [{ ...input, parentId: g('coordinator') }] }]);

    await expect((await guard.grants.get(g('researcher'))).create(input))
      .rejects.toThrow('A token may only delegate from the grant it references.');
  });

  it('sets capabilities below its own grant, never on its own grant or beside it', async () => {
    const { guard, calls } = guarded();
    const researcher = await guard.grants.get(g('researcher'));

    expect([...(await researcher.capabilities.set([])).capabilities]).toEqual([]);
    expect(calls).toEqual([{ method: 'setCapabilities', args: [g('researcher'), []] }]);

    await expect(guard.grants.get(g('ghost'))).rejects.toThrow('Grant does not exist.');
    await expect((await guard.grants.get(g('other'))).capabilities.set([]))
      .rejects.toThrow("That grant is neither this token's grant nor delegated from it.");
  });

  it('refuses to set the capabilities of the grant its own token references', async () => {
    const { guard, calls } = guarded(subBearer);

    await expect((await guard.grants.get(g('researcher'))).capabilities.set([]))
      .rejects.toThrow('A token may not set the capabilities of its own grant.');
    expect(calls).toEqual([]);
  });

  it('issues and revokes tokens only within its own grant branch', async () => {
    const { guard, calls } = guarded();

    expect((await (await guard.grants.get(g('researcher'))).tokens.create({ label: 'sub' })).value).toBe('issued-value');
    await (await guard.tokens.get(tokenId('demo'))).revoke();
    expect(calls).toEqual([
      { method: 'issueToken', args: [g('researcher'), 'sub'] },
      { method: 'revokeToken', args: [tokenId('demo')] },
    ]);

    await expect((await guard.grants.get(g('other'))).tokens.create({ label: 'nope' }))
      .rejects.toThrow("That grant is neither this token's grant nor delegated from it.");
    await expect(guard.tokens.get(tokenId('ghost'))).rejects.toThrow('Token does not exist.');
  });

  it('revokes a grant within its own branch, including its own grant', async () => {
    const { guard, calls } = guarded();

    await (await guard.grants.get(g('coordinator'))).revoke();
    await (await guard.grants.get(g('researcher'))).revoke();
    expect(calls.map((call) => call.args[0])).toEqual([g('coordinator'), g('researcher')]);

    // A grant that resolves to no record is refused at lookup rather than walking a missing lineage.
    await expect(guard.grants.get(g('ghost'))).rejects.toThrow('Grant does not exist.');
  });
});
