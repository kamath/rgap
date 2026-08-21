import { describe, expect, it } from 'vitest';
import { authorize, createGrant, createResource, deleteResource, moveResource, requireResourceId, resourceIdAtPath, revokeGrant, setCapabilities, stateIntegrity, tryResourcePath } from './domain';
import { fixture } from './fixture';

const at = '2026-08-22T00:00:00.000Z';
const demoHash = 'b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3';

describe('RGAP domain', () => {
  it('authorizes only capabilities present in the complete grant chain', () => {
    expect(authorize(fixture(), demoHash, 'create-issue', 'invoke', at).allowed).toBe(true);
    expect(authorize(fixture(), demoHash, 'post-message', 'invoke', at).allowed).toBe(false);
  });

  it('reports a path for a deleted resource and none for a record that is gone', () => {
    const state = deleteResource(fixture(), 'search-files', at);

    expect(tryResourcePath(state.resources, 'search-files')).toBe('acme/drive/search-files');

    delete state.resources['search-files'];
    expect(tryResourcePath(state.resources, 'search-files')).toBe(null);
  });

  it('reports every reference that no longer resolves to a record', () => {
    expect(stateIntegrity(fixture())).toEqual([]);

    const state = fixture();
    delete state.resources['search-files'];
    delete state.grants.coordinator;

    expect(stateIntegrity(state)).toEqual([
      'Grant researcher refers to missing parent coordinator.',
      'Grant researcher refers to missing resource search-files.',
      'Token demo refers to missing grant coordinator.',
    ]);
  });

  it('rejects delegation that expands permission', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [{
      resourceId: 'drive', permissions: ['read'], descendants: true, relocation: 'revoke_on_scope_exit',
    }];

    expect(() => createGrant(state, {
      name: 'Writer', subject: 'writer agent', parentId: 'coordinator', expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [{ resourceId: 'read-file', permissions: ['write'], descendants: false, relocation: 'revoke_on_scope_exit' }],
    }, 'writer', at)).toThrow('not covered');
  });

  it('creates a grant that reaches nothing until its capabilities are set', () => {
    const created = createGrant(fixture(), {
      name: 'Empty', subject: 'sub-agent', parentId: 'coordinator',
      expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
    }, 'empty', at);

    expect(created.grants.empty.capabilities).toEqual([]);

    const withEntry = setCapabilities(created, 'empty', [
      { resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit' },
    ], at);
    expect(withEntry.grants.empty.capabilities).toHaveLength(1);
  });

  it('holds a set to the same downscoping proof as issue', () => {
    const state = createGrant(fixture(), {
      name: 'Empty', subject: 'sub-agent', parentId: 'coordinator',
      expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
    }, 'empty', at);

    // The coordinator holds `invoke` on search-files, so neither a wider permission nor a
    // resource it does not reach may be set on a grant delegated from it.
    expect(() => setCapabilities(state, 'empty', [
      { resourceId: 'search-files', permissions: ['write'], descendants: false, relocation: 'revoke_on_scope_exit' },
    ], at)).toThrow('not covered by the parent');
    expect(() => setCapabilities(state, 'empty', [
      { resourceId: 'post-message', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit' },
    ], at)).toThrow('not covered by the parent');
    expect(() => setCapabilities(state, 'empty', [
      { resourceId: 'search-files', permissions: [], descendants: false, relocation: 'revoke_on_scope_exit' },
    ], at)).toThrow('at least one permission');
  });

  it('revokes a direct child the new set no longer covers, and its descendants', () => {
    let state = fixture();
    state = createGrant(state, {
      name: 'Deeper', subject: 'sub-sub-agent', parentId: 'researcher',
      expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [{ resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit' }],
    }, 'deeper', at);

    // The coordinator gives up search-files, which is all the researcher held.
    const next = setCapabilities(state, 'coordinator', [
      { resourceId: 'create-issue', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit' },
    ], at);

    expect(next.grants.coordinator.revokedAt).toBe(null);
    expect(next.grants.researcher.revokedAt).toBe(at);
    expect(next.grants.deeper.revokedAt).toBe(at);
    expect(next.audit[0].detail).toContain('Researcher');
  });

  it('orphans a child by narrowing relocation policy, not only by giving up a resource', () => {
    let state = fixture();
    state.grants.coordinator.capabilities = [
      { resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'follow_resource' },
    ];
    state = createGrant(state, {
      name: 'Follower', subject: 'sub-agent', parentId: 'coordinator', expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [{ resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'follow_resource' }],
    }, 'follower', at);

    const next = setCapabilities(state, 'coordinator', [
      { resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit' },
    ], at);

    expect(next.grants.follower.revokedAt).toBe(at);
  });

  it('refuses to amend a grant that is not active', () => {
    const state = revokeGrant(fixture(), 'researcher', at);

    expect(() => setCapabilities(state, 'researcher', [], at)).toThrow('revoked or expired grant is not amended');
  });

  it('revokes a delegated grant when its resource leaves parent scope', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [{
      resourceId: 'drive', permissions: ['invoke'], descendants: true, relocation: 'revoke_on_scope_exit',
    }];
    state.grants.researcher.capabilities = [{
      resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit',
    }];

    const moved = moveResource(state, 'search-files', 'slack-tools', at);
    expect(moved.grants.researcher.revokedAt).toBe(at);
  });

  it('resolves a path to a stable ID and refuses a path that names nothing', () => {
    const state = fixture();

    expect(resourceIdAtPath(state.resources, '/acme//drive/')).toBe('drive');
    expect(resourceIdAtPath(state.resources, 'acme/missing')).toBe(null);
    expect(resourceIdAtPath(state.resources, '')).toBe(null);
    expect(() => requireResourceId(state.resources, 'acme/missing')).toThrow('No resource exists at acme/missing.');
  });

  it('keeps a deleted resource as an unresolvable tombstone that still holds its ID', () => {
    const deleted = deleteResource(fixture(), 'drive', at);

    expect(deleted.resources.drive.deletedAt).toBe(at);
    expect(deleted.resources['search-files'].deletedAt).toBe(at);
    expect(resourceIdAtPath(deleted.resources, 'acme/drive')).toBe(null);
    expect(authorize(deleted, demoHash, 'search-files', 'invoke', at).detail).toBe('Resource does not exist.');
    expect(() => moveResource(deleted, 'drive', 'acme', at)).toThrow('Resource does not exist.');
  });

  it('frees a deleted name without reissuing its stable ID', () => {
    const deleted = deleteResource(fixture(), 'drive', at);
    const recreated = createResource(deleted, {
      name: 'drive', parentId: 'acme', movePolicy: 'normal', deletePolicy: 'revoke',
    }, 'drive-2', at);

    expect(resourceIdAtPath(recreated.resources, 'acme/drive')).toBe('drive-2');
    expect(() => createResource(recreated, {
      name: 'anything', parentId: 'acme', movePolicy: 'normal', deletePolicy: 'revoke',
    }, 'drive', at)).toThrow('Resource drive already exists.');
  });

  it('refuses a child rooted outside its parent, whatever the relocation policies are', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [{
      resourceId: 'search-files', permissions: ['invoke'], descendants: false, relocation: 'follow_resource',
    }];

    expect(() => createGrant(state, {
      name: 'Escalated', subject: 'bad actor', parentId: 'coordinator', expiresAt,
      capabilities: [{ resourceId: 'post-message', permissions: ['invoke'], descendants: false, relocation: 'follow_resource' }],
    }, 'escalated', at)).toThrow('not covered');
  });

  it('refuses a child that widens descendants past its parent', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [{
      resourceId: 'drive', permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit',
    }];

    expect(() => createGrant(state, {
      name: 'Widened', subject: 'sub-agent', parentId: 'coordinator', expiresAt,
      capabilities: [{ resourceId: 'drive', permissions: ['invoke'], descendants: true, relocation: 'revoke_on_scope_exit' }],
    }, 'widened', at)).toThrow('not covered');

    expect(createGrant(state, {
      name: 'Narrowed', subject: 'sub-agent', parentId: 'coordinator', expiresAt,
      capabilities: [{ resourceId: 'drive', permissions: ['invoke'], descendants: false, relocation: 'deny_move' }],
    }, 'narrowed', at).grants.narrowed.name).toBe('Narrowed');
  });

  it('never authorizes a descendant grant beyond the grant it was delegated from', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [{
      resourceId: 'drive', permissions: ['invoke'], descendants: false, relocation: 'follow_resource',
    }];
    // A capability that was never covered cannot appear through a stored grant either.
    state.grants.researcher.capabilities = [{
      resourceId: 'post-message', permissions: ['invoke'], descendants: false, relocation: 'follow_resource',
    }];
    state.tokens.demo.grantId = 'researcher';

    expect(authorize(state, demoHash, 'post-message', 'invoke', at).allowed).toBe(false);
  });

  it('cascades ancestor revocation', () => {
    const revoked = revokeGrant(fixture(), 'coordinator', at);
    expect(revoked.grants.coordinator.revokedAt).toBe(at);
    expect(revoked.grants.researcher.revokedAt).toBe(at);
  });
});
