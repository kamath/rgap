import { describe, expect, it } from 'vitest';
import { executableRevisionId, grantId, resourceId, tokenId, tokenValue } from './domain';
import { fixture, stubCommands } from './fixture';
import { pageLimit, paginateRecords, repositoryFrom } from './repository';

const at = '2026-08-22T00:00:00.000Z';
const collect = async <T>(values: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

describe('repositoryFrom', () => {
  it('bounds page sizes and advances stable cursors', () => {
    const records = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    expect(pageLimit()).toBe(50);
    expect(pageLimit(Number.NaN)).toBe(50);
    expect(pageLimit(0)).toBe(1);
    expect(pageLimit(1000)).toBe(100);
    expect(pageLimit(2.9)).toBe(2);
    expect(paginateRecords(records, { limit: 2 })).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(paginateRecords(records, { cursor: 'b', limit: 2 })).toEqual([{ id: 'c' }]);
    expect(() => paginateRecords(records, { cursor: 'missing' })).toThrow('cursor is unknown');
  });

  it('creates roots on the repository collections and children on the parent handle', async () => {
    const { commands, calls } = stubCommands(fixture(), at);
    const repository = repositoryFrom(commands);

    const acme = await repository.resources.create({ name: 'acme' });
    const notes = await acme.create({ name: 'notes' });
    await notes.move(resourceId('drive'));
    await notes.delete();

    const grant = await repository.grants.create({ name: 'Admin', capabilities: [], expiresAt: null });
    const child = await grant.create({ name: 'Reader', capabilities: [], expiresAt: null });
    await child.capabilities.set([]);
    const issued = await grant.tokens.create({ label: 'cli' });
    await issued.revoke();
    await child.revoke();

    expect(calls.map((call) => call.method)).toEqual([
      'createResource', 'createResource', 'moveResource', 'deleteResource',
      'createGrant', 'createGrant', 'setCapabilities', 'issueToken', 'revokeToken', 'revokeGrant',
    ]);
    expect(calls[0].args[0]).toEqual({ name: 'acme', parentId: null });
    expect(calls[1].args[0]).toEqual({ name: 'notes', parentId: resourceId('created') });
    expect(issued.value).toBe('issued-value');
  });

  it('looks up existing records and refuses missing or deleted ones', async () => {
    const state = fixture();
    state.resources.drive.deletedAt = at;
    const { commands } = stubCommands(state, at);
    const repository = repositoryFrom(commands);

    expect((await repository.resources.get(resourceId('acme'))).name).toBe('acme');
    expect((await repository.grants.get(grantId('coordinator'))).name).toBe('Coordinator');
    expect((await repository.tokens.get(tokenId('demo'))).label).toBe('demo');

    await expect(repository.resources.get(resourceId('ghost'))).rejects.toThrow('Resource does not exist.');
    await expect(repository.resources.get(resourceId('drive'))).rejects.toThrow('Resource does not exist.');
    await expect(repository.grants.get(grantId('ghost'))).rejects.toThrow('Grant does not exist.');
    await expect(repository.tokens.get(tokenId('ghost'))).rejects.toThrow('Token does not exist.');
  });

  it('forwards collection queries, authorize, inspect, and reset', async () => {
    const { commands, calls } = stubCommands(fixture(), at);
    const repository = repositoryFrom(commands);
    const token = tokenValue('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');

    expect((await repository.resources.list({ parentId: resourceId('acme') })).map(({ id }) => id))
      .toEqual(['create-issue', 'drive', 'slack']);
    expect((await repository.grants.list()).map(({ id }) => id)).toContain('coordinator');
    expect((await repository.tokens.list({ grantId: grantId('coordinator') }))[0].id).toBe('demo');
    expect(await repository.audit.list()).toEqual([]);
    expect((await repository.authorize(token, resourceId('search-files'), 'invoke')).allowed).toBe(true);
    expect((await repository.inspectToken(token)).grantId).toBe('coordinator');
    await repository.reset();
    expect(calls).toEqual([{ method: 'reset', args: [] }]);
  });

  it('exposes executable, secret, private metadata, and invocation commands on both surfaces', async () => {
    const state = fixture();
    const revision = {
      id: executableRevisionId('existing'), resourceId: resourceId('search-files'), runtime: 'test',
      program: {}, inputSchema: true, outputSchema: null, bindingSchema: {}, limits: {},
      createdAt: at,
    };
    state.executables['search-files'] = {
      resourceId: resourceId('search-files'), activeRevisionId: revision.id, deletedAt: null,
    };
    state.executableRevisions.existing = revision;
    state.secretMetadata['search-files'] = {
      resourceId: resourceId('search-files'), version: 'one', updatedAt: at,
    };
    state.runtimePrivateMetadata[`test\u0000search-files`] = {
      runtime: 'test', resourceId: resourceId('search-files'), version: 'one', updatedAt: at,
    };
    const { commands, calls } = stubCommands(state, at);
    const repository = repositoryFrom(commands);
    const resource = await repository.resources.get(resourceId('search-files'));
    const publish = {
      runtime: 'test', program: {}, inputSchema: true, outputSchema: null, bindingSchema: {}, limits: {},
    };

    expect((await resource.executable.get())?.activeRevisionId).toBe('existing');
    expect(await resource.executable.revisions()).toEqual([revision]);
    expect((await repository.executables.getRevision(revision.id))?.runtime).toBe('test');
    expect((await repository.executables.get(resource.id))?.resourceId).toBe(resource.id);
    expect(await repository.executables.revisions(resource.id)).toEqual([revision]);
    await resource.executable.publish(publish);
    await repository.executables.publish(resource.id, publish);
    await resource.executable.delete();
    await repository.executables.delete(resource.id);
    expect((await resource.secret.metadata())?.version).toBe('one');
    expect((await repository.secrets.metadata(resource.id))?.version).toBe('one');
    expect(resource.secret).not.toHaveProperty('resolve');
    expect(repository.secrets).not.toHaveProperty('resolve');
    await resource.secret.write('protected');
    await repository.secrets.write(resource.id, 'protected');
    await resource.secret.delete();
    await repository.secrets.delete(resource.id);
    expect((await resource.runtimePrivateMetadata('test'))?.version).toBe('one');
    expect((await repository.runtimePrivateMetadata('test', resource.id))?.version).toBe('one');
    expect(await collect(resource.invoke({ input: null }))).toEqual([{ type: 'done' }]);
    expect(await collect(repository.invoke(resource.id, { input: null }))).toEqual([{ type: 'done' }]);
    expect(calls.map(({ method }) => method)).toEqual([
      'publishExecutable', 'publishExecutable', 'deleteExecutable', 'deleteExecutable',
      'writeSecret', 'writeSecret', 'deleteSecret', 'deleteSecret', 'invoke', 'invoke',
    ]);
  });
});
