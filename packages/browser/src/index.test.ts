import { describe, expect, it } from 'vitest';
import { resourceIdAtPath, type State } from '@rgap/core';
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
    acme: { id: 'acme', parentId: null, name: 'Acme', deletedAt: null },
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
      name: 'New tool', parentId: 'acme',
    });

    const state = await repo.readState();
    expect(state.resources[resource.id]).toEqual(resource);
    expect(Object.values(state).some((value) => typeof value === 'function')).toBe(false);
  });

  it('moves a root resource under another parent', async () => {
    const repo = repository();
    const resource = await repo.createResource({
      name: 'child', parentId: null,
    });

    expect((await repo.moveResource(resource.id, 'acme')).parentId).toBe('acme');
    expect((await repo.moveResource(resource.id, null)).parentId).toBe(null);
  });

  it('retains a deleted resource as a tombstone and never reissues its ID', async () => {
    const repo = repository();
    const first = await repo.createResource({
      name: 'tools', parentId: 'acme',
    });
    await repo.deleteResource(first.id);

    const replacement = await repo.createResource({
      name: 'tools', parentId: 'acme',
    });
    const state = await repo.readState();

    expect(replacement.id).not.toBe(first.id);
    expect(state.resources[first.id].deletedAt).not.toBe(null);
    expect(resourceIdAtPath(state.resources, 'Acme/tools')).toBe(replacement.id);
  });

  it('creates root and delegated grants', async () => {
    const repo = repository();
    const root = await repo.createGrant({
      name: 'Reader', subject: 'reader agent', parentId: null, expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'acme' }, permissions: ['read'], descendants: true }],
    });
    const child = await repo.createGrant({
      name: 'Narrow reader', subject: 'sub-agent', parentId: root.id, expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'acme' }, permissions: ['read'], descendants: false }],
    });

    expect(child.parentId).toBe(root.id);
  });

  it('round-trips resource and path capability targets', async () => {
    const storage = memoryStorage();
    const seeded = new BrowserRgapRepository({ initialState: initialState(), storage });
    const grant = await seeded.createGrant({
      name: 'Mixed targets', subject: 'agent', parentId: null, expiresAt: null,
      capabilities: [
        { target: { type: 'resource', resourceId: 'acme' }, permissions: ['read'], descendants: true },
        { target: { type: 'path', path: 'Acme/future' }, permissions: ['invoke'], descendants: false },
      ],
    });

    const restored = await new BrowserRgapRepository({ initialState: initialState(), storage }).readState();
    expect(restored.grants[grant.id].capabilities).toEqual(grant.capabilities);
  });

  it('does not revoke grants when resources move or are deleted', async () => {
    const repo = repository();
    const child = await repo.createResource({ name: 'child', parentId: 'acme' });
    const grant = await repo.createGrant({
      name: 'Reader', subject: 'agent', parentId: null, expiresAt: null,
      capabilities: [
        { target: { type: 'resource', resourceId: child.id }, permissions: ['read'], descendants: false },
        { target: { type: 'path', path: 'Acme/child' }, permissions: ['read'], descendants: false },
      ],
    });

    await repo.moveResource(child.id, null);
    await repo.deleteResource(child.id);

    expect((await repo.readState()).grants[grant.id].revokedAt).toBe(null);
  });

  it('discards stored state whose references no longer resolve', async () => {
    const storage = memoryStorage();
    const seeded = new BrowserRgapRepository({ initialState: initialState(), storage });
    await seeded.createGrant({
      name: 'Owner', subject: 'owner', parentId: null, expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'acme' }, permissions: ['read'], descendants: true }],
    });
    // The resource record the stored grant names, gone the way an older seed's records would be.
    const stored = JSON.parse(storage.getItem('rgap-state') as string);
    delete stored.state.resources['acme'];
    storage.setItem('rgap-state', JSON.stringify(stored));

    const state = await new BrowserRgapRepository({ initialState: initialState(), storage }).readState();

    expect(state.resources['acme']).toBeDefined();
    expect(Object.keys(state.grants)).toEqual([]);
  });

  it('loads stored state that is referentially intact', async () => {
    const storage = memoryStorage();
    const seeded = new BrowserRgapRepository({ initialState: initialState(), storage });
    const created = await seeded.createResource({
      name: 'Tools', parentId: 'acme',
    });

    const state = await new BrowserRgapRepository({ initialState: initialState(), storage }).readState();

    expect(resourceIdAtPath(state.resources, 'Acme/Tools')).toBe(created.id);
  });

  it('issues tokens and inspects their effective authority', async () => {
    const repo = repository();
    const grant = await repo.createGrant({
      name: 'Reader', subject: 'reader agent', parentId: null, expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'acme' }, permissions: ['read'], descendants: false }],
    });
    const issued = await repo.issueToken(grant.id, 'reader token');

    expect((await repo.inspectToken(issued.value)).permissions.acme).toEqual(['read']);
    expect((await repo.inspectToken('wrong token')).valid).toBe(false);
  });
});
