import { describe, expect, it } from 'vitest';
import {
  grantId, resourceId, tokenHash, tokenId, tokenValue, type GrantBinding, type State,
} from './domain';
import { fixture, stubCommands } from './fixture';
import { guardCommands } from './guard';
import { repositoryFrom } from './repository';

const at = '2026-08-22T00:00:00.000Z';
const bearer = tokenValue('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');
const subBearer = tokenValue('sub-token-hash');
const r = resourceId;
const g = grantId;
const cap = (id: string, permissions: GrantBinding['permissions']): GrantBinding =>
  ({ id: r(id), permissions });

/** The demo token references `coordinator`, which holds every permission across the drive subtree. */
function state(): State {
  const base = fixture();
  base.grants.coordinator.bindings = [
    cap('drive', ['read', 'write', 'delete', 'move', 'invoke', 'bind']),
  ];
  base.grants.researcher.bindings = [
    { id: r('search-files'), permissions: ['invoke'] },
  ];
  // A grant tree beside the acting grant, which no token on the coordinator branch reaches.
  base.grants['other-root'] = {
    id: g('other-root'), name: 'Other root', parentId: null,
    bindings: [], expiresAt: null, revokedAt: null,
  };
  base.grants.other = {
    id: g('other'), name: 'Other', parentId: g('other-root'),
    bindings: [], expiresAt: null, revokedAt: null,
  };
  // A second token on a delegated grant, which has a parent whose authority its holder cannot claim.
  base.tokens.sub = {
    id: tokenId('sub'), grantId: g('researcher'), label: 'sub', hash: tokenHash('sub-token-hash'), expiresAt: null, revokedAt: null,
  };
  base.tokens.other = {
    id: tokenId('other'), grantId: g('other'), label: 'other', hash: tokenHash('other-token-hash'), expiresAt: null, revokedAt: null,
  };
  return base;
}

const guarded = (token = bearer) => {
  const { commands, calls, resolveBearer } = stubCommands(state(), at);
  return { guard: guardCommands(repositoryFrom(commands), token, resolveBearer), calls };
};

describe('command guard', () => {
  it('filters collection queries to the token view', async () => {
    const { guard, calls } = guarded();

    expect((await guard.resources.list()).map(({ id }) => id))
      .toEqual(['acme', 'drive', 'read-file', 'search-files']);
    expect((await guard.resources.list({ limit: 2 })).map(({ id }) => id)).toEqual(['acme', 'drive']);
    expect((await guard.resources.list({ cursor: 'drive', limit: 2 })).map(({ id }) => id))
      .toEqual(['read-file', 'search-files']);
    expect((await guard.grants.list()).map(({ id }) => id)).toEqual(['coordinator', 'researcher']);
    expect((await guard.tokens.list()).map(({ id }) => id)).toEqual(['demo', 'sub']);
    expect(await guard.audit.list()).toEqual([]);
    await expect(guard.resources.get(r('slack'))).rejects.toThrow('outside this token');
    await expect(guard.grants.get(g('other'))).rejects.toThrow('outside this token');
    await expect(guard.tokens.get(tokenId('other'))).rejects.toThrow('outside this token');
    expect((await guard.authorize(bearer, r('search-files'), 'invoke')).allowed).toBe(true);
    expect(calls).toEqual([]);
  });

  it('filters and paginates audit events by visible target type', async () => {
    const initial = state();
    for (let index = 0; index < 100; index++) {
      const id = r(`hidden-resource-${index.toString().padStart(3, '0')}`);
      initial.resources[id] = {
        id, parentId: r('slack'), name: id, deletedAt: null, executable: null,
      };
    }
    initial.audit = [
      { id: 'resource-visible', at, action: 'resource.move', target: r('search-files'), result: 'recorded', detail: '' },
      { id: 'resource-hidden', at, action: 'authorize', target: r('slack'), result: 'denied', detail: '' },
      { id: 'grant-visible', at, action: 'grant.revoke', target: g('researcher'), result: 'recorded', detail: '' },
      { id: 'grant-hidden', at, action: 'grant.revoke', target: g('other'), result: 'recorded', detail: '' },
      { id: 'token-visible', at, action: 'token.revoke', target: tokenId('demo'), result: 'recorded', detail: '' },
      { id: 'unknown-action', at, action: 'other', target: r('drive'), result: 'recorded', detail: '' },
    ];
    const { commands, resolveBearer } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer, resolveBearer);

    expect((await guard.audit.list()).map(({ id }) => id))
      .toEqual(['resource-visible', 'grant-visible', 'token-visible']);

    initial.audit = Array.from({ length: 100 }, (_, index) => ({
      id: `hidden-${index}`,
      at,
      action: 'other',
      target: r('slack'),
      result: 'recorded' as const,
      detail: '',
    }));
    initial.audit.push({
      id: 'visible-after-cursor', at, action: 'resource.move',
      target: r('drive'), result: 'recorded', detail: '',
    });
    expect((await guard.audit.list({ limit: 1 }))[0].id).toBe('visible-after-cursor');
  });

  it('refuses every command to a token it cannot resolve to a grant', async () => {
    const { guard } = guarded(tokenValue('unknown-token'));

    await expect(guard.grants.get(g('coordinator')))
      .rejects.toThrow('Token is unknown, expired, or revoked.');
    await expect(guard.grants.create({
      name: 'Child', bindings: [], expiresAt: null,
    })).rejects.toThrow('Token is unknown, expired, or revoked.');
    await expect(guard.resources.list()).rejects.toThrow('Token is unknown, expired, or revoked.');
  });

  it('refuses the operations no token authorizes', async () => {
    const { guard, calls } = guarded();
    const drive = await guard.resources.get(r('drive'));

    await expect(guard.resources.create({ name: 'root' }))
      .rejects.toThrow('Creating a root resource is an administrative operation');
    await expect(guard.resources.create({ name: 'acme/notes' }))
      .rejects.toThrow('No write resource survives the complete grant chain.');
    await expect(drive.update({ parentId: null })).rejects.toThrow('Moving a resource to a root is an administrative');
    await expect((await guard.grants.get(g('coordinator'))).bindings.set([]))
      .rejects.toThrow("Setting a root grant's bindings is an administrative");
    await expect(guard.reset()).rejects.toThrow('Resetting the store is an administrative');
    expect(calls).toEqual([]);
  });

  it('creates a resource only where the token holds write on the parent', async () => {
    const { guard, calls } = guarded();
    const drive = await guard.resources.get(r('drive'));

    expect((await drive.create({ name: 'notes' })).id).toBe('created');
    expect((await guard.resources.create({ name: 'acme/drive/notes' })).id).toBe('created');
    expect((await drive.create({
      name: 'configured',
      executable: {
        runtime: 'test',
        input: { model: 'gpt-5.6-sol' },
        bind: { source: r('read-file') },
      },
    })).id).toBe('created');
    expect((await guard.resources.create({
      name: 'acme/drive/configured',
      executable: {
        runtime: 'test',
        input: { model: 'gpt-5.6-sol' },
      },
    })).id).toBe('created');
    expect(calls).toEqual([
      { method: 'createResource', args: [{ name: 'notes', parentId: r('drive') }] },
      { method: 'createResource', args: [{ name: 'acme/drive/notes', parentId: null }] },
      {
        method: 'createResource',
        args: [{
          name: 'configured',
          parentId: r('drive'),
          executable: {
            runtime: 'test',
            input: { model: 'gpt-5.6-sol' },
            bind: { source: r('read-file') },
          },
        }],
      },
      {
        method: 'createResource',
        args: [{
          name: 'acme/drive/configured',
          parentId: null,
          executable: {
            runtime: 'test',
            input: { model: 'gpt-5.6-sol' },
          },
        }],
      },
    ]);

    await expect(guard.resources.get(r('slack'))).rejects.toThrow('outside this token');
  });

  it('pages through siblings when resolving a create path', async () => {
    const initial = state();
    for (let index = 0; index < 100; index += 1) {
      const id = r(`sib-${String(index).padStart(3, '0')}`);
      initial.resources[id] = { id, parentId: r('drive'), name: `sib-${index}`, deletedAt: null, executable: null };
    }
    const { commands, calls, resolveBearer } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer, resolveBearer);

    expect((await guard.resources.create({ name: 'acme/drive/notes' })).id).toBe('created');
    expect(calls).toEqual([
      { method: 'createResource', args: [{ name: 'acme/drive/notes', parentId: null }] },
    ]);
  });

  it('reparents a resource only with move on the resource and write on the destination', async () => {
    const { guard, calls } = guarded();
    const search = await guard.resources.get(r('search-files'));

    expect((await search.update({ parentId: r('read-file') })).parentId).toBe('read-file');
    expect(calls).toEqual([{
      method: 'updateResource',
      args: [r('search-files'), { parentId: r('read-file') }],
    }]);

    await expect(guard.resources.get(r('post-message'))).rejects.toThrow('outside this token');
    await expect((await guard.resources.get(r('search-files'))).update({ parentId: r('slack') }))
      .rejects.toThrow('No write resource survives the complete grant chain.');
  });

  it('deletes a resource only where the token holds delete on it', async () => {
    const { guard, calls } = guarded();

    await (await guard.resources.get(r('read-file'))).delete();
    expect(calls).toEqual([{ method: 'deleteResource', args: [r('read-file')] }]);

    await expect(guard.resources.get(r('post-message'))).rejects.toThrow('outside this token');
  });

  it('creates only on routes beneath the acting grant', async () => {
    const { guard, calls } = guarded();
    const child = { name: 'Child', bindings: [], expiresAt: null };
    const route = { ...child, name: 'Coordinator/Child' };

    expect((await guard.grants.create(route)).id).toBe('created');
    expect((await (await guard.grants.get(g('coordinator'))).create(child)).id).toBe('created');
    expect((await (await guard.grants.get(g('researcher'))).create(child)).id).toBe('created');
    expect(calls).toEqual([
      { method: 'createGrant', args: [{ ...route, parentId: null }] },
      { method: 'createGrant', args: [{ ...child, parentId: g('coordinator') }] },
      { method: 'createGrant', args: [{ ...child, parentId: g('researcher') }] },
    ]);

    await expect(guard.grants.create({ ...child, name: 'Other root/Child' }))
      .rejects.toThrow('must follow existing ancestors to the acting grant');
    await expect(guard.grants.create({ ...child, name: 'Coordinator peer/Child' }))
      .rejects.toThrow('must follow existing ancestors to the acting grant');
  });

  it('does not let a delegated token create from an ancestor grant', async () => {
    const { guard, calls } = guarded(subBearer);
    const input = { name: 'Child', bindings: [], expiresAt: null };

    await expect((await guard.grants.get(g('coordinator'))).create(input))
      .rejects.toThrow('neither this token\'s grant nor delegated from it');
    expect((await guard.grants.create({ ...input, name: 'Coordinator/Researcher/Child' })).id)
      .toBe('created');
    expect(calls).toEqual([
      { method: 'createGrant', args: [{ ...input, name: 'Coordinator/Researcher/Child', parentId: null }] },
    ]);
  });

  it('sets bindings below its own grant, never on its own grant or beside it', async () => {
    const { guard, calls } = guarded();
    const researcher = await guard.grants.get(g('researcher'));

    expect([...(await researcher.bindings.set([])).bindings]).toEqual([]);
    expect(calls).toEqual([{ method: 'setBindings', args: [g('researcher'), []] }]);

    await expect(guard.grants.get(g('ghost'))).rejects.toThrow('outside this token');
    await expect(guard.grants.get(g('other'))).rejects.toThrow('outside this token');
  });

  it('refuses to set the bindings of the grant its own token references', async () => {
    const { guard, calls } = guarded(subBearer);

    await expect((await guard.grants.get(g('researcher'))).bindings.set([]))
      .rejects.toThrow('A token may not set the bindings of its own grant.');
    await expect((await guard.grants.get(g('coordinator'))).tokens.create({ label: 'parent' }))
      .rejects.toThrow('neither this token\'s grant nor delegated from it');
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

    await expect(guard.grants.get(g('other'))).rejects.toThrow('outside this token');
    await expect(guard.tokens.get(tokenId('ghost'))).rejects.toThrow('outside this token');
  });

  it('revokes a grant within its own branch, including its own grant', async () => {
    const { guard, calls } = guarded();

    await (await guard.grants.get(g('coordinator'))).revoke();
    await (await guard.grants.get(g('researcher'))).revoke();
    expect(calls.map((call) => call.args[0])).toEqual([g('coordinator'), g('researcher')]);

    await expect(guard.grants.get(g('ghost'))).rejects.toThrow('outside this token');
  });

  it('guards embedded executable updates and invocation', async () => {
    const initial = state();
    initial.resources['search-files'].executable = {
      runtime: 'test', input: {}, bind: {},
    };
    const { commands, calls, resolveBearer } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer, resolveBearer);
    const search = await guard.resources.get(r('search-files'));

    expect(search.executable?.runtime).toBe('test');
    await search.update({
      executable: {
        runtime: 'test',
        bind: { source: r('read-file') },
      },
    });
    await search.update({ executable: { runtime: 'test' } });
    for await (const event of guard.invoke(r('search-files'), { input: {} })) {
      expect(event.type).toBe('done');
    }
    for await (const event of search.invoke({ input: {} })) {
      expect(event.type).toBe('done');
    }
    expect(calls.map(({ method }) => method)).toEqual([
      'updateResource', 'updateResource', 'invoke', 'invoke',
    ]);
  });

  it('does not treat caller input strings as binding authority', async () => {
    const initial = state();
    initial.resources['search-files'].executable = {
      runtime: 'test',
      input: {},
      bind: {},
    };
    const { commands, calls, resolveBearer } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer, resolveBearer);

    for await (const event of guard.invoke(r('drive'), { input: {} })) {
      expect(event.type).toBe('done');
    }
    for await (const event of guard.invoke(r('search-files'), {
      input: { target: r('read-file') },
    })) {
      expect(event.type).toBe('done');
    }
    for await (const event of guard.invoke(r('search-files'), {
      input: {},
    })) {
      expect(event.type).toBe('done');
    }

    expect(calls.map(({ method }) => method)).toEqual(['invoke', 'invoke', 'invoke']);
  });
});
