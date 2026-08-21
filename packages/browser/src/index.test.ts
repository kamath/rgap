import { describe, expect, it } from 'vitest';
import type { State } from '@rgap/core';
import { BrowserRgapRepository } from './index';

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

const initialState = (): State => ({
  resources: {
    acme: { id: 'acme', parentId: null, name: 'Acme', movePolicy: 'normal', deletePolicy: 'revoke' },
  },
  grants: {},
  tokens: {},
  audit: [],
});

const repository = () => new BrowserRgapRepository({ initialState: initialState(), storage: memoryStorage() });

describe('BrowserRgapRepository', () => {
  it('keeps actions outside serializable snapshots', async () => {
    const repo = repository();
    const resource = await repo.createResource({
      name: 'New tool', parentPath: 'Acme/new/server',
      movePolicy: 'deny_while_granted', deletePolicy: 'deny_while_granted',
    });

    expect(repo.getSnapshot().resources[resource.id]).toEqual(resource);
    expect(Object.values(repo.getSnapshot()).some((value) => typeof value === 'function')).toBe(false);
  });

  it('moves a resource from a new root path into Acme with a canonical path', async () => {
    const repo = repository();
    const resource = await repo.createResource({
      name: 'child', parentPath: 'new', movePolicy: 'normal', deletePolicy: 'revoke',
    });

    expect((await repo.moveResource(resource.id, '/Acme//')).parentId).toBe('acme');
  });

  it('creates root and delegated grants', async () => {
    const repo = repository();
    const root = await repo.createGrant({
      name: 'Reader', subject: 'reader agent', parentId: null, expiresAt: null,
      capabilities: [{ resourceId: 'acme', permissions: ['read'], descendants: true, relocation: 'revoke_on_scope_exit' }],
    });
    const child = await repo.createGrant({
      name: 'Narrow reader', subject: 'sub-agent', parentId: root.id, expiresAt: null,
      capabilities: [{ resourceId: 'acme', permissions: ['read'], descendants: false, relocation: 'deny_move' }],
    });

    expect(child.parentId).toBe(root.id);
  });

  it('issues tokens and inspects their effective authority', async () => {
    const repo = repository();
    const grant = await repo.createGrant({
      name: 'Reader', subject: 'reader agent', parentId: null, expiresAt: null,
      capabilities: [{ resourceId: 'acme', permissions: ['read'], descendants: false, relocation: 'revoke_on_scope_exit' }],
    });
    const issued = await repo.issueToken(grant.id, 'reader token');

    expect((await repo.inspectToken(issued.value)).permissions.acme).toEqual(['read']);
    expect((await repo.inspectToken('wrong token')).valid).toBe(false);
  });
});
