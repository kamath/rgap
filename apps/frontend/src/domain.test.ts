import { describe, expect, it } from 'vitest';
import { authorize, createGrant, moveResource, revokeGrant } from './domain';
import { seed } from './seed';

const at = '2026-08-22T00:00:00.000Z';
const demoHash = 'b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3';

describe('RGAP domain', () => {
  it('authorizes only capabilities present in the complete grant chain', () => {
    expect(authorize(seed(), demoHash, 'create-issue', 'invoke', at).allowed).toBe(true);
    expect(authorize(seed(), demoHash, 'post-message', 'invoke', at).allowed).toBe(false);
  });

  it('rejects delegation that expands permission', () => {
    const state = seed();
    state.grants.coordinator.capabilities = [{
      resourceId: 'drive', permissions: ['read'], descendants: true, relocation: 'revoke_on_scope_exit',
    }];

    expect(() => createGrant(state, {
      name: 'Writer', subject: 'writer agent', parentId: 'coordinator', expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [{ resourceId: 'read-file', permissions: ['write'], descendants: false, relocation: 'revoke_on_scope_exit' }],
    }, 'writer', at)).toThrow('not covered');
  });

  it('revokes a delegated grant when its resource leaves parent scope', () => {
    const state = seed();
    state.grants.coordinator.capabilities = [{
      resourceId: 'drive', permissions: ['invoke'], descendants: true, relocation: 'revoke_on_scope_exit',
    }];
    state.grants.researcher.capabilities = [{
      resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit',
    }];

    const moved = moveResource(state, 'search-files', 'slack-tools', at);
    expect(moved.grants.researcher.revokedAt).toBe(at);
  });

  it('cascades ancestor revocation', () => {
    const revoked = revokeGrant(seed(), 'coordinator', at);
    expect(revoked.grants.coordinator.revokedAt).toBe(at);
    expect(revoked.grants.researcher.revokedAt).toBe(at);
  });
});
