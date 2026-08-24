import { describe, expect, it } from 'vitest';
import { grantId, resourceId, tokenId, tokenValue } from './domain';
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

    const grant = await repository.grants.create({ name: 'Admin', resources: [], expiresAt: null });
    const child = await grant.create({ name: 'Reader', resources: [], expiresAt: null });
    await child.resources.set([]);
    const issued = await grant.tokens.create({ label: 'cli' });
    await issued.revoke();
    await child.revoke();

    expect(calls.map((call) => call.method)).toEqual([
      'createResource', 'createResource', 'moveResource', 'deleteResource',
      'createGrant', 'createGrant', 'setResources', 'issueToken', 'revokeToken', 'revokeGrant',
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

  it('forwards collection queries, authorize, and reset', async () => {
    const { commands, calls } = stubCommands(fixture(), at);
    const repository = repositoryFrom(commands);
    const token = tokenValue('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');

    expect((await repository.resources.list({ parentId: resourceId('acme') })).map(({ id }) => id))
      .toEqual(['create-issue', 'drive', 'slack']);
    expect((await repository.grants.list()).map(({ id }) => id)).toContain('coordinator');
    expect((await repository.tokens.list({ grantId: grantId('coordinator') }))[0].id).toBe('demo');
    expect(await repository.audit.list()).toEqual([]);
    expect((await repository.authorize(token, resourceId('search-files'), 'invoke')).allowed).toBe(true);
    await repository.reset();
    expect(calls).toEqual([{ method: 'reset', args: [] }]);
  });

  it('exposes executable and invocation commands on both surfaces', async () => {
    const state = fixture();
    state.executables['search-files'] = {
      resourceId: resourceId('search-files'), runtime: 'test', bind: {},
    };
    const { commands, calls } = stubCommands(state, at);
    const repository = repositoryFrom(commands);
    const resource = await repository.resources.get(resourceId('search-files'));

    expect((await resource.executable.get())?.runtime).toBe('test');
    expect((await repository.executables.get(resource.id))?.resourceId).toBe(resource.id);
    await resource.executable.set({ runtime: 'test' });
    await repository.executables.set(resource.id, { runtime: 'test' });
    await resource.executable.delete();
    await repository.executables.delete(resource.id);
    expect(await collect(resource.invoke({ input: null }))).toEqual([{ type: 'done' }]);
    expect(await collect(repository.invoke(resource.id, { input: null }))).toEqual([{ type: 'done' }]);
    expect(calls.map(({ method }) => method)).toEqual([
      'setExecutable', 'setExecutable', 'deleteExecutable', 'deleteExecutable',
      'invoke', 'invoke',
    ]);
  });
});
