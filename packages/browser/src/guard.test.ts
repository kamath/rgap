import { describe, expect, it } from 'vitest';
import { grantId, requireResourceId, resourceId, tokenValue, type State } from '@rgap/core';
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

const resource = (id: string, parent: string | null, name: string) =>
  ({ id: resourceId(id), parentId: parent ? resourceId(parent) : null, name, deletedAt: null });

const initialState = (): State => ({
  resources: Object.fromEntries([
    resource('acme', null, 'Acme'),
    resource('drive', 'acme', 'Drive'),
    resource('tools', 'drive', 'Tools'),
    resource('slack', 'acme', 'Slack'),
  ].map((item) => [item.id, item])),
  grants: {
    owner: {
      id: grantId('owner'), name: 'Owner', parentId: null, expiresAt: null, revokedAt: null,
      capabilities: [{
        resourceId: resourceId('drive'),
        permissions: ['read', 'write', 'move', 'delete'],
      }],
    },
  },
  tokens: {},
  audit: [],
});

const guarded = async () => {
  const store = new BrowserRgapStore({ initialState: initialState(), storage: memoryStorage() });
  const admin = store.admin();
  const issued = await (await admin.grants.get(grantId('owner'))).tokens.create({ label: 'owner token' });
  return { admin, store, token: issued.value, repo: store.as(issued.value) };
};

describe('BrowserRgapStore token plane', () => {
  it('allows a command the token authorizes', async () => {
    const { repo, admin } = await guarded();

    const created = await (await repo.resources.get(resourceId('tools'))).create({ name: 'read_file' });

    expect((await admin.resources.get(created.id)).parentId).toBe('tools');
  });

  it('refuses a command outside the token authority, with the decision explanation', async () => {
    const { repo } = await guarded();

    await expect(repo.resources.get(resourceId('slack'))).rejects.toThrow('outside this token');
  });

  it('lets a token set what a grant below it reaches, but never its own grant', async () => {
    const { admin, store } = await guarded();
    const entry = [{
      resourceId: resourceId('tools'),
      permissions: ['read' as const],
    }];
    // The acting grant is delegated, not a root, so the own-grant rule is what refuses it.
    const acting = await (await admin.grants.get(grantId('owner'))).create({
      name: 'Middle', expiresAt: null, capabilities: entry,
    });
    const below = await acting.create({
      name: 'Below', expiresAt: null, capabilities: [],
    });
    const issued = await acting.tokens.create({ label: 'middle token' });
    const repo = store.as(issued.value);

    expect((await (await repo.grants.get(below.id)).capabilities.set(entry)).capabilities).toHaveLength(1);

    // Amending its own entries would let the holder widen itself to its parent's full authority.
    await expect((await repo.grants.get(acting.id)).capabilities.set(entry)).rejects.toThrow('its own grant');
  });

  it('refuses to set capabilities on a root grant or a grant outside the token', async () => {
    const { repo, admin } = await guarded();
    const beside = await admin.grants.create({
      name: 'Beside', expiresAt: null, capabilities: [],
    });
    const below = await beside.create({
      name: 'Below beside', expiresAt: null, capabilities: [],
    });

    await expect(repo.grants.get(beside.id)).rejects.toThrow('outside this token');
    await expect(repo.grants.get(below.id)).rejects.toThrow('outside this token');
  });

  it('requires authority at both ends of a move', async () => {
    const { repo, admin } = await guarded();

    await expect((await repo.resources.get(resourceId('tools'))).move(resourceId('slack'))).rejects.toThrow('No write capability survives');
    expect((await admin.resources.get(resourceId('tools'))).parentId).toBe('drive');
    expect((await (await repo.resources.get(resourceId('tools'))).move(resourceId('drive'))).parentId).toBe('drive');
  });

  it('refuses administrative operations outright', async () => {
    const { repo } = await guarded();

    await expect(repo.resources.create({ name: 'root' })).rejects.toThrow('administrative operation');
    await expect((await repo.resources.get(resourceId('tools'))).move(null)).rejects.toThrow('administrative operation');
    await expect(repo.reset()).rejects.toThrow('administrative operation');
  });

  it('delegates only from the grant the token references, and reaches only that subtree', async () => {
    const { repo, admin, token } = await guarded();
    const child = await repo.grants.create({
      name: 'Reader', expiresAt: null,
      capabilities: [{ resourceId: resourceId('tools'), permissions: ['read'] }],
    });
    expect(child.parentId).toBe(grantId('owner'));

    const issued = await child.tokens.create({ label: 'reader token' });
    expect(issued.grantId).toBe(child.id);

    const outsider = await admin.grants.create({
      name: 'Outsider', expiresAt: null,
      capabilities: [{ resourceId: resourceId('slack'), permissions: ['read'] }],
    });
    await expect(repo.grants.get(outsider.id)).rejects.toThrow('outside this token');

    await child.revoke();
    expect((await admin.grants.get(child.id)).revokedAt).not.toBe(null);

    const resources = await repo.resources.list();
    expect(requireResourceId(resources, 'Acme/Drive/Tools')).toBe('tools');
    expect((await repo.inspectToken(token)).valid).toBe(true);
  });

  it('refuses every command for an unknown or revoked token', async () => {
    const { admin, repo, store, token } = await guarded();
    const unknown = store.as(tokenValue('rgap_not_a_token'));

    await expect(unknown.resources.get(resourceId('tools'))).rejects.toThrow('outside this token');
    await expect(unknown.grants.get(grantId('owner'))).rejects.toThrow('outside this token');

    const record = (await admin.tokens.list({ grantId: grantId('owner') }))[0];
    await (await admin.tokens.get(record!.id)).revoke();
    await expect(repo.resources.get(resourceId('tools'))).rejects.toThrow('outside this token');
  });
});
