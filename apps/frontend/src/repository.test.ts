import { describe, expect, it } from 'vitest';
import { BrowserRgapRepository } from './repository';

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
};

describe('BrowserRgapRepository', () => {
  it('passes data-only snapshots to domain operations', async () => {
    const repository = new BrowserRgapRepository(memoryStorage());
    const resource = await repository.createResource({
      name: 'New tool', parentPath: 'Acme/MCP servers/new/server',
      movePolicy: 'deny_while_granted', deletePolicy: 'deny_while_granted',
    });

    expect(repository.getSnapshot().resources[resource.id]).toEqual(resource);
    expect(resource.movePolicy).toBe('deny_while_granted');
    expect(Object.values(repository.getSnapshot().resources).some((item) => item.name === 'server')).toBe(true);
    expect(Object.values(repository.getSnapshot()).some((value) => typeof value === 'function')).toBe(false);
  });

  it('changes authority when the bearer token changes', async () => {
    const repository = new BrowserRgapRepository(memoryStorage());
    const view = await repository.inspectToken('rgap_demo_coordinator');
    const invalid = await repository.inspectToken('wrong-token');

    expect(view.valid).toBe(true);
    expect(view.permissions['search-files']).toEqual(['invoke']);
    expect(view.permissions['post-message']).toBeUndefined();
    expect(invalid.valid).toBe(false);
  });

  it('moves a resource from a new root path into Acme with a canonical path', async () => {
    const repository = new BrowserRgapRepository(memoryStorage());
    const resource = await repository.createResource({
      name: 'child', parentPath: 'new', movePolicy: 'normal', deletePolicy: 'revoke',
    });

    const moved = await repository.moveResource(resource.id, '/Acme//');
    expect(moved.parentId).toBe('acme');
    expect('type' in moved).toBe(false);
  });

  it('creates root and delegated grants through the repository', async () => {
    const repository = new BrowserRgapRepository(memoryStorage());
    const root = await repository.createGrant({
      name: 'Reader', subject: 'reader agent', parentId: null, expiresAt: null,
      capabilities: [{ resourceId: 'acme', permissions: ['read'], descendants: true, relocation: 'revoke_on_scope_exit' }],
    });
    const child = await repository.createGrant({
      name: 'Narrow reader', subject: 'sub-agent', parentId: root.id, expiresAt: null,
      capabilities: [{ resourceId: 'mcp', permissions: ['read'], descendants: false, relocation: 'deny_move' }],
    });

    expect(child.parentId).toBe(root.id);
  });
});
