import { describe, expect, expectTypeOf, it } from 'vitest';
import { resourceId, resourceIdAtPath, tokenValue, type RgapRepository, type State } from '@rgap/core';
import { BrowserRgapStore } from './index';

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
    acme: { id: resourceId('acme'), parentId: null, name: 'Acme', deletedAt: null },
  },
  grants: {},
  tokens: {},
  audit: [],
});

const repository = () => new BrowserRgapStore({ initialState: initialState(), storage: memoryStorage() }).admin();

const resourceRecord = (resource: { id: string; parentId: string | null; name: string; deletedAt: string | null }) =>
  ({ id: resource.id, parentId: resource.parentId, name: resource.name, deletedAt: resource.deletedAt });

describe('BrowserRgapStore', () => {
  it('exposes command planes rather than repository commands', () => {
    const store = new BrowserRgapStore({ initialState: initialState(), storage: memoryStorage() });
    expectTypeOf<Extract<keyof BrowserRgapStore, keyof RgapRepository>>().toEqualTypeOf<never>();
    expect(store).not.toHaveProperty('resources');
  });

  it('keeps actions outside serializable snapshots', async () => {
    const repo = repository();
    const resource = await (await repo.resources.get(resourceId('acme'))).create({ name: 'New tool' });

    const state = await repo.readState();
    expect(state.resources[resource.id]).toEqual(resourceRecord(resource));
    expect(Object.values(state).some((value) => typeof value === 'function')).toBe(false);
  });

  it('moves a root resource under another parent', async () => {
    const repo = repository();
    const resource = await repo.resources.create({ name: 'child' });

    expect((await resource.move(resourceId('acme'))).parentId).toBe('acme');
    expect((await (await repo.resources.get(resource.id)).move(null)).parentId).toBe(null);
  });

  it('retains a deleted resource as a tombstone and never reissues its ID', async () => {
    const repo = repository();
    const first = await (await repo.resources.get(resourceId('acme'))).create({ name: 'tools' });
    await first.delete();

    const replacement = await (await repo.resources.get(resourceId('acme'))).create({ name: 'tools' });
    const state = await repo.readState();

    expect(replacement.id).not.toBe(first.id);
    expect(state.resources[first.id].deletedAt).not.toBe(null);
    expect(resourceIdAtPath(state.resources, 'Acme/tools')).toBe(replacement.id);
  });

  it('creates root and delegated grants', async () => {
    const repo = repository();
    const root = await repo.grants.create({
      name: 'Reader', expiresAt: null,
      capabilities: [{ resourceId: resourceId('acme'), permissions: ['read'] }],
    });
    const child = await root.create({
      name: 'Narrow reader', expiresAt: null,
      capabilities: [{ resourceId: resourceId('acme'), permissions: ['read'] }],
    });

    expect(child.parentId).toBe(root.id);
  });

  it('round-trips resource and path capability targets', async () => {
    const storage = memoryStorage();
    const seeded = new BrowserRgapStore({ initialState: initialState(), storage }).admin();
    const grant = await seeded.grants.create({
      name: 'Mixed targets', expiresAt: null,
      capabilities: [
        { resourceId: resourceId('acme'), permissions: ['read'] },
        { path: 'Acme/future', permissions: ['invoke'] },
      ],
    });

    const restored = await new BrowserRgapStore({ initialState: initialState(), storage }).admin().readState();
    expect(restored.grants[grant.id].capabilities).toEqual([...grant.capabilities]);
  });

  it('does not revoke grants when resources move or are deleted', async () => {
    const repo = repository();
    const child = await (await repo.resources.get(resourceId('acme'))).create({ name: 'child' });
    const grant = await repo.grants.create({
      name: 'Reader', expiresAt: null,
      capabilities: [
        { resourceId: child.id, permissions: ['read'] },
        { path: 'Acme/child', permissions: ['read'] },
      ],
    });

    await child.move(null);
    await child.delete();

    expect((await repo.readState()).grants[grant.id].revokedAt).toBe(null);
  });

  it('discards stored state whose references no longer resolve', async () => {
    const storage = memoryStorage();
    const seeded = new BrowserRgapStore({ initialState: initialState(), storage }).admin();
    await seeded.grants.create({
      name: 'Owner', expiresAt: null,
      capabilities: [{ resourceId: resourceId('acme'), permissions: ['read'] }],
    });
    // The resource record the stored grant names, gone the way an older seed's records would be.
    const stored = JSON.parse(storage.getItem('rgap-state') as string);
    delete stored.state.resources['acme'];
    storage.setItem('rgap-state', JSON.stringify(stored));

    const state = await new BrowserRgapStore({ initialState: initialState(), storage }).admin().readState();

    expect(state.resources['acme']).toBeDefined();
    expect(Object.keys(state.grants)).toEqual([]);
  });

  it('loads stored state that is referentially intact', async () => {
    const storage = memoryStorage();
    const seeded = new BrowserRgapStore({ initialState: initialState(), storage }).admin();
    const created = await (await seeded.resources.get(resourceId('acme'))).create({ name: 'Tools' });

    const state = await new BrowserRgapStore({ initialState: initialState(), storage }).admin().readState();

    expect(resourceIdAtPath(state.resources, 'Acme/Tools')).toBe(created.id);
  });

  it('issues tokens and inspects their effective authority', async () => {
    const repo = repository();
    const grant = await repo.grants.create({
      name: 'Reader', expiresAt: null,
      capabilities: [{ resourceId: resourceId('acme'), permissions: ['read'] }],
    });
    const issued = await grant.tokens.create({ label: 'reader token' });

    expect((await repo.inspectToken(issued.value)).permissions.acme).toEqual(['read']);
    expect((await repo.inspectToken(tokenValue('wrong token'))).valid).toBe(false);
  });
});
