import { describe, expect, it } from 'vitest';
import { guardCommands, requireResourceId, type State } from '@rgap/core';
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

const resource = (id: string, parentId: string | null, name: string) =>
  ({ id, parentId, name, movePolicy: 'normal' as const, deletePolicy: 'revoke' as const, deletedAt: null });

const initialState = (): State => ({
  resources: Object.fromEntries([
    resource('acme', null, 'Acme'),
    resource('drive', 'acme', 'Drive'),
    resource('tools', 'drive', 'Tools'),
    resource('slack', 'acme', 'Slack'),
  ].map((item) => [item.id, item])),
  grants: {
    owner: {
      id: 'owner', name: 'Owner', subject: 'owner', parentId: null, expiresAt: null, revokedAt: null,
      capabilities: [{
        resourceId: 'drive', permissions: ['read', 'write', 'move', 'delete'],
        descendants: true, relocation: 'revoke_on_scope_exit',
      }],
    },
  },
  tokens: {},
  audit: [],
});

const guarded = async () => {
  const admin = new BrowserRgapRepository({ initialState: initialState(), storage: memoryStorage() });
  const issued = await admin.issueToken('owner', 'owner token');
  return { admin, token: issued.value, repo: guardCommands(admin, issued.value) };
};

describe('guardCommands', () => {
  it('allows a command the token authorizes', async () => {
    const { repo, admin } = await guarded();

    const created = await repo.createResource({
      name: 'read_file', parentId: 'tools', movePolicy: 'normal', deletePolicy: 'revoke',
    });

    expect((await admin.readState()).resources[created.id].parentId).toBe('tools');
  });

  it('refuses a command outside the token authority, with the decision explanation', async () => {
    const { repo } = await guarded();

    await expect(repo.createResource({
      name: 'intruder', parentId: 'slack', movePolicy: 'normal', deletePolicy: 'revoke',
    })).rejects.toThrow('No write capability survives the complete grant chain.');
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
      name: 'root', parentId: null, movePolicy: 'normal', deletePolicy: 'revoke',
    })).rejects.toThrow('administrative operation');
    await expect(repo.moveResource('tools', null)).rejects.toThrow('administrative operation');
    await expect(repo.reset()).rejects.toThrow('administrative operation');
    await expect(repo.createGrant({
      name: 'Root', subject: 'someone', parentId: null, expiresAt: null,
      capabilities: [{ resourceId: 'drive', permissions: ['read'], descendants: false, relocation: 'deny_move' }],
    })).rejects.toThrow('administrative operation');
  });

  it('delegates only from the grant the token references, and reaches only that subtree', async () => {
    const { repo, admin, token } = await guarded();
    const child = await repo.createGrant({
      name: 'Reader', subject: 'sub-agent', parentId: 'owner', expiresAt: null,
      capabilities: [{ resourceId: 'tools', permissions: ['read'], descendants: false, relocation: 'revoke_on_scope_exit' }],
    });

    const issued = await repo.issueToken(child.id, 'reader token');
    expect(issued.record.grantId).toBe(child.id);

    const outsider = await admin.createGrant({
      name: 'Outsider', subject: 'other', parentId: null, expiresAt: null,
      capabilities: [{ resourceId: 'slack', permissions: ['read'], descendants: false, relocation: 'deny_move' }],
    });
    await expect(repo.issueToken(outsider.id, 'nope')).rejects.toThrow('neither this token');
    await expect(repo.revokeGrant(outsider.id)).rejects.toThrow('neither this token');

    await repo.revokeGrant(child.id);
    expect((await admin.readState()).grants[child.id].revokedAt).not.toBe(null);

    expect(requireResourceId((await repo.readState()).resources, 'Acme/Drive/Tools')).toBe('tools');
    expect((await repo.inspectToken(token)).valid).toBe(true);
  });

  it('refuses every command for an unknown or revoked token', async () => {
    const { admin, repo, token } = await guarded();
    const unknown = guardCommands(admin, 'rgap_not_a_token');

    await expect(unknown.deleteResource('tools')).rejects.toThrow('unknown, expired, or revoked');
    await expect(unknown.revokeGrant('owner')).rejects.toThrow('unknown, expired, or revoked');

    const record = Object.values((await admin.readState()).tokens).find((item) => item.grantId === 'owner');
    await admin.revokeToken(record!.id);
    await expect(repo.deleteResource('tools')).rejects.toThrow('unknown, expired, or revoked');
  });
});
