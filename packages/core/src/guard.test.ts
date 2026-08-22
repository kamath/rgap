import { describe, expect, it } from 'vitest';
import {
  executableRevisionId, grantId, resourceId, tokenHash, tokenId, tokenValue, type Capability, type State,
} from './domain';
import { fixture, stubCommands } from './fixture';
import { guardCommands } from './guard';
import { repositoryFrom } from './repository';

const at = '2026-08-22T00:00:00.000Z';
const bearer = tokenValue('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');
const subBearer = tokenValue('sub-token-hash');
const r = resourceId;
const g = grantId;
const cap = (id: string, permissions: Capability['permissions']): Capability =>
  ({ resourceId: r(id), permissions });

/** The demo token references `coordinator`, which holds every permission across the drive subtree. */
function state(): State {
  const base = fixture();
  base.grants.coordinator.capabilities = [cap('drive', ['read', 'write', 'use', 'delete', 'move', 'invoke'])];
  base.grants.researcher.capabilities = [
    { resourceId: r('search-files'), permissions: ['invoke'] },
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
  base.tokens.other = {
    id: tokenId('other'), grantId: g('other'), label: 'other', hash: tokenHash('other-token-hash'), expiresAt: null, revokedAt: null,
  };
  return base;
}

const guarded = (token = bearer) => {
  const { commands, calls } = stubCommands(state(), at);
  return { guard: guardCommands(repositoryFrom(commands), token), calls };
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
    expect((await guard.inspectToken(bearer)).grantId).toBe('coordinator');
    expect(calls).toEqual([]);
  });

  it('filters and paginates audit events by visible target type', async () => {
    const initial = state();
    initial.audit = [
      { id: 'resource-visible', at, action: 'resource.move', target: r('search-files'), result: 'recorded', detail: '' },
      { id: 'resource-hidden', at, action: 'authorize', target: r('slack'), result: 'denied', detail: '' },
      { id: 'grant-visible', at, action: 'grant.revoke', target: g('researcher'), result: 'recorded', detail: '' },
      { id: 'grant-hidden', at, action: 'grant.revoke', target: g('other'), result: 'recorded', detail: '' },
      { id: 'token-visible', at, action: 'token.revoke', target: tokenId('demo'), result: 'recorded', detail: '' },
      { id: 'unknown-action', at, action: 'other', target: r('drive'), result: 'recorded', detail: '' },
    ];
    const { commands } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer);

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

    await expect(guard.grants.get(g('coordinator'))).rejects.toThrow('outside this token');
    await expect(guard.grants.create({
      name: 'Child', capabilities: [], expiresAt: null,
    })).rejects.toThrow('Token is unknown, expired, or revoked.');
    expect(await guard.resources.list()).toEqual([]);
  });

  it('refuses the operations no token authorizes', async () => {
    const { guard, calls } = guarded();
    const drive = await guard.resources.get(r('drive'));

    await expect(guard.resources.create({ name: 'root' }))
      .rejects.toThrow('Creating a root resource is an administrative operation');
    await expect(drive.move(null)).rejects.toThrow('Moving a resource to a root is an administrative');
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

    await expect(guard.resources.get(r('slack'))).rejects.toThrow('outside this token');
  });

  it('moves a resource only with move on the resource and write on the destination', async () => {
    const { guard, calls } = guarded();
    const search = await guard.resources.get(r('search-files'));

    expect((await search.move(r('read-file'))).parentId).toBe('read-file');
    expect(calls).toEqual([{ method: 'moveResource', args: [r('search-files'), r('read-file')] }]);

    await expect(guard.resources.get(r('post-message'))).rejects.toThrow('outside this token');
    await expect((await guard.resources.get(r('search-files'))).move(r('slack')))
      .rejects.toThrow('No write capability survives the complete grant chain.');
  });

  it('deletes a resource only where the token holds delete on it', async () => {
    const { guard, calls } = guarded();

    await (await guard.resources.get(r('read-file'))).delete();
    expect(calls).toEqual([{ method: 'deleteResource', args: [r('read-file')] }]);

    await expect(guard.resources.get(r('post-message'))).rejects.toThrow('outside this token');
  });

  it('delegates from the acting grant, including via grants.create', async () => {
    const { guard, calls } = guarded();
    const input = { name: 'Child', capabilities: [], expiresAt: null };

    expect((await guard.grants.create(input)).id).toBe('created');
    expect((await (await guard.grants.get(g('coordinator'))).create(input)).id).toBe('created');
    expect(calls).toEqual([
      { method: 'createGrant', args: [{ ...input, parentId: g('coordinator') }] },
      { method: 'createGrant', args: [{ ...input, parentId: g('coordinator') }] },
    ]);

    await expect((await guard.grants.get(g('researcher'))).create(input))
      .rejects.toThrow('A token may only delegate from the grant it references.');
  });

  it('sets capabilities below its own grant, never on its own grant or beside it', async () => {
    const { guard, calls } = guarded();
    const researcher = await guard.grants.get(g('researcher'));

    expect([...(await researcher.capabilities.set([])).capabilities]).toEqual([]);
    expect(calls).toEqual([{ method: 'setCapabilities', args: [g('researcher'), []] }]);

    await expect(guard.grants.get(g('ghost'))).rejects.toThrow('outside this token');
    await expect(guard.grants.get(g('other'))).rejects.toThrow('outside this token');
  });

  it('refuses to set the capabilities of the grant its own token references', async () => {
    const { guard, calls } = guarded(subBearer);

    await expect((await guard.grants.get(g('researcher'))).capabilities.set([]))
      .rejects.toThrow('A token may not set the capabilities of its own grant.');
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

  it('guards executable metadata, publishing, secrets, private metadata, and binding invocation', async () => {
    const initial = state();
    const revision = {
      id: executableRevisionId('revision'), resourceId: r('search-files'), runtime: 'test',
      program: {}, inputSchema: true, outputSchema: null,
      bindingSchema: { target: { kind: 'resource' as const, access: 'write' as const } },
      limits: {}, createdAt: at,
    };
    initial.executables['search-files'] = {
      resourceId: r('search-files'), activeRevisionId: revision.id, deletedAt: null,
    };
    initial.executableRevisions.revision = revision;
    initial.secretMetadata['search-files'] = {
      resourceId: r('search-files'), version: 'one', updatedAt: at,
    };
    initial.runtimePrivateMetadata[`test\u0000search-files`] = {
      runtime: 'test', resourceId: r('search-files'), version: 'one', updatedAt: at,
    };
    const { commands, calls } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer);
    const search = await guard.resources.get(r('search-files'));
    const publication = {
      runtime: 'test', program: {}, inputSchema: true, outputSchema: null, bindingSchema: {}, limits: {},
    };

    expect((await guard.executables.get(r('search-files')))?.activeRevisionId).toBe('revision');
    expect((await guard.executables.getRevision(revision.id))?.resourceId).toBe('search-files');
    expect(await guard.executables.getRevision(executableRevisionId('missing'))).toBeUndefined();
    expect(await guard.executables.revisions(r('search-files'))).toEqual([revision]);
    expect((await search.executable.get())?.resourceId).toBe('search-files');
    expect(await search.executable.revisions()).toEqual([revision]);
    await guard.executables.publish(r('search-files'), publication);
    await search.executable.publish(publication);
    await guard.executables.delete(r('search-files'));
    await search.executable.delete();
    expect((await guard.secrets.metadata(r('search-files')))?.version).toBe('one');
    expect((await search.secret.metadata())?.version).toBe('one');
    await guard.secrets.write(r('search-files'), 'protected');
    await search.secret.write('protected');
    await guard.secrets.delete(r('search-files'));
    await search.secret.delete();
    expect((await guard.runtimePrivateMetadata('test', r('search-files')))?.version).toBe('one');
    expect((await search.runtimePrivateMetadata('test'))?.version).toBe('one');

    for await (const event of guard.invoke(r('search-files'), {
      input: {}, bindings: { target: r('drive') },
    })) expect(event.type).toBe('done');
    for await (const event of search.invoke({ input: {}, bindings: { target: r('drive') } })) {
      expect(event.type).toBe('done');
    }
    expect(calls.map(({ method }) => method)).toEqual([
      'publishExecutable', 'publishExecutable', 'deleteExecutable', 'deleteExecutable',
      'writeSecret', 'writeSecret', 'deleteSecret', 'deleteSecret', 'invoke', 'invoke',
    ]);
    await expect(guard.secrets.write(r('post-message'), 'protected'))
      .rejects.toThrow('No write capability');
  });

  it('invokes without bindings and only infers writes from a matching revision', async () => {
    const initial = state();
    const revision = {
      id: executableRevisionId('branch-revision'),
      resourceId: r('search-files'),
      runtime: 'test',
      program: {},
      inputSchema: true,
      outputSchema: null,
      bindingSchema: {
        readonly: { kind: 'resource' as const, access: 'use' as const },
      },
      limits: {},
      createdAt: at,
    };
    initial.executableRevisions[revision.id] = revision;
    initial.executables['search-files'] = {
      resourceId: r('search-files'),
      activeRevisionId: revision.id,
      deletedAt: null,
    };
    const { commands, calls } = stubCommands(initial, at);
    const guard = guardCommands(repositoryFrom(commands), bearer);

    for await (const event of guard.invoke(r('drive'), { input: {} })) {
      expect(event.type).toBe('done');
    }
    for await (const event of guard.invoke(r('drive'), {
      input: {},
      revisionId: revision.id,
      bindings: { readonly: r('read-file') },
    })) {
      expect(event.type).toBe('done');
    }
    for await (const event of guard.invoke(r('search-files'), {
      input: {},
      revisionId: revision.id,
      bindings: { readonly: r('read-file'), undeclared: r('drive') },
    })) {
      expect(event.type).toBe('done');
    }
    for await (const event of guard.invoke(r('search-files'), {
      input: {},
      revisionId: revision.id,
    })) {
      expect(event.type).toBe('done');
    }

    expect(calls.map(({ method }) => method)).toEqual(['invoke', 'invoke', 'invoke', 'invoke']);
  });
});
