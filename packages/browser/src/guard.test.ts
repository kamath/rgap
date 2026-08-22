import { describe, expect, it } from 'vitest';
import { requireResourceId, type State } from '@rgap/core';
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

const resource = (id: string, parentId: string | null, name: string) =>
  ({ id, parentId, name, deletedAt: null });

const initialState = (): State => ({
  resources: Object.fromEntries([
    resource('acme', null, 'Acme'),
    resource('drive', 'acme', 'Drive'),
    resource('tools', 'drive', 'Tools'),
    resource('slack', 'acme', 'Slack'),
  ].map((item) => [item.id, item])),
  grants: {
    owner: {
      id: 'owner', name: 'Owner', parentId: null, expiresAt: null, revokedAt: null,
      capabilities: [{
        target: { type: 'resource', resourceId: 'drive' },
        permissions: ['read', 'write', 'move', 'delete'], descendants: true,
      }],
    },
  },
  tokens: {},
  audit: [],
});

const guarded = async () => {
  const store = new BrowserRgapStore({ initialState: initialState(), storage: memoryStorage() });
  const admin = store.admin();
  const issued = await admin.issueToken('owner', 'owner token');
  return { admin, store, token: issued.value, repo: store.as(issued.value) };
};

describe('BrowserRgapStore token plane', () => {
  it('allows a command the token authorizes', async () => {
    const { repo, admin } = await guarded();

    const created = await repo.createResource({
      name: 'read_file', parentId: 'tools',
    });

    expect((await admin.readState()).resources[created.id].parentId).toBe('tools');
  });

  it('refuses a command outside the token authority, with the decision explanation', async () => {
    const { repo } = await guarded();

    await expect(repo.createResource({
      name: 'intruder', parentId: 'slack',
    })).rejects.toThrow('No write capability survives the complete grant chain.');
  });

  it('lets a token set what a grant below it reaches, but never its own grant', async () => {
    const { admin, store } = await guarded();
    const entry = [{
      target: { type: 'resource' as const, resourceId: 'tools' },
      permissions: ['read' as const], descendants: false,
    }];
    // The acting grant is delegated, not a root, so the own-grant rule is what refuses it.
    const acting = await admin.createGrant({
      name: 'Middle', parentId: 'owner', expiresAt: null, capabilities: entry,
    });
    const below = await admin.createGrant({
      name: 'Below', parentId: acting.id, expiresAt: null, capabilities: [],
    });
    const issued = await admin.issueToken(acting.id, 'middle token');
    const repo = store.as(issued.value);

    expect((await repo.setCapabilities(below.id, entry)).capabilities).toHaveLength(1);

    // Amending its own entries would let the holder widen itself to its parent's full authority.
    await expect(repo.setCapabilities(acting.id, entry)).rejects.toThrow('its own grant');
  });

  it('refuses to set capabilities on a root grant or a grant outside the token', async () => {
    const { repo, admin } = await guarded();
    const beside = await admin.createGrant({
      name: 'Beside', parentId: null, expiresAt: null, capabilities: [],
    });
    const below = await admin.createGrant({
      name: 'Below beside', parentId: beside.id, expiresAt: null, capabilities: [],
    });

    await expect(repo.setCapabilities(beside.id, [])).rejects.toThrow('administrative operation');
    await expect(repo.setCapabilities(below.id, [])).rejects.toThrow('neither this token\'s grant nor delegated from it');
  });

  it('requires authority at both ends of a move', async () => {
    const { repo, admin } = await guarded();

    await expect(repo.moveResource('tools', 'slack')).rejects.toThrow('No write capability survives');
    expect((await admin.readState()).resources.tools.parentId).toBe('drive');
    expect((await repo.moveResource('tools', 'drive')).parentId).toBe('drive');
  });

  it('refuses administrative operations outright', async () => {
    const { repo } = await guarded();

    await expect(repo.createResource({
      name: 'root', parentId: null,
    })).rejects.toThrow('administrative operation');
    await expect(repo.moveResource('tools', null)).rejects.toThrow('administrative operation');
    await expect(repo.reset()).rejects.toThrow('administrative operation');
    await expect(repo.createGrant({
      name: 'Root', parentId: null, expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'drive' }, permissions: ['read'], descendants: false }],
    })).rejects.toThrow('administrative operation');
  });

  it('delegates only from the grant the token references, and reaches only that subtree', async () => {
    const { repo, admin, token } = await guarded();
    const child = await repo.createGrant({
      name: 'Reader', parentId: 'owner', expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'tools' }, permissions: ['read'], descendants: false }],
    });

    const issued = await repo.issueToken(child.id, 'reader token');
    expect(issued.record.grantId).toBe(child.id);

    const outsider = await admin.createGrant({
      name: 'Outsider', parentId: null, expiresAt: null,
      capabilities: [{ target: { type: 'resource', resourceId: 'slack' }, permissions: ['read'], descendants: false }],
    });
    await expect(repo.issueToken(outsider.id, 'nope')).rejects.toThrow('neither this token');
    await expect(repo.revokeGrant(outsider.id)).rejects.toThrow('neither this token');

    await repo.revokeGrant(child.id);
    expect((await admin.readState()).grants[child.id].revokedAt).not.toBe(null);

    expect(requireResourceId((await repo.readState()).resources, 'Acme/Drive/Tools')).toBe('tools');
    expect((await repo.inspectToken(token)).valid).toBe(true);
  });

  it('refuses every command for an unknown or revoked token', async () => {
    const { admin, repo, store, token } = await guarded();
    const unknown = store.as('rgap_not_a_token');

    await expect(unknown.deleteResource('tools')).rejects.toThrow('unknown, expired, or revoked');
    await expect(unknown.revokeGrant('owner')).rejects.toThrow('unknown, expired, or revoked');

    const record = Object.values((await admin.readState()).tokens).find((item) => item.grantId === 'owner');
    await admin.revokeToken(record!.id);
    await expect(repo.deleteResource('tools')).rejects.toThrow('unknown, expired, or revoked');
  });
});
