import { describe, expect, it } from 'vitest';
import {
  authorize, availableId, covers, createGrant, createResource, deleteResource, inspectAuthority, isLive,
  isWithin, liveResources, moveResource, normalizePath, permissions, recordToken, requireResourceId,
  resourceIdAtPath, resourcePath, revokeGrant, revokeToken, setCapabilities, stateIntegrity, tryResourcePath,
  type Capability, type Resource, type State, type Token,
} from './domain';
import { fixture } from './fixture';

const at = '2026-08-22T00:00:00.000Z';
const demoHash = 'b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3';
const cap = (
  resourceId: string,
  over: Partial<Omit<Capability, 'target'>> = {},
): Capability => ({
  target: { type: 'resource', resourceId },
  permissions: ['invoke'],
  descendants: false,
  ...over,
});
const pathCap = (
  path: string,
  over: Partial<Omit<Capability, 'target'>> = {},
): Capability => ({
  target: { type: 'path', path },
  permissions: ['invoke'],
  descendants: false,
  ...over,
});

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
    state.grants.coordinator.capabilities = [cap('drive', { permissions: ['read'], descendants: true })];

    expect(() => createGrant(state, {
      name: 'Writer', parentId: 'coordinator', expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [cap('read-file', { permissions: ['write'] })],
    }, 'writer', at)).toThrow('not covered');
  });

  it('creates a grant that reaches nothing until its capabilities are set', () => {
    const created = createGrant(fixture(), {
      name: 'Empty', parentId: 'coordinator',
      expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
    }, 'empty', at);

    expect(created.grants.empty.capabilities).toEqual([]);

    const withEntry = setCapabilities(created, 'empty', [
      cap('search-files'),
    ], at);
    expect(withEntry.grants.empty.capabilities).toHaveLength(1);
  });

  it('holds a set to the same downscoping proof as issue', () => {
    const state = createGrant(fixture(), {
      name: 'Empty', parentId: 'coordinator',
      expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
    }, 'empty', at);

    // The coordinator holds `invoke` on search-files, so neither a wider permission nor a
    // resource it does not reach may be set on a grant delegated from it.
    expect(() => setCapabilities(state, 'empty', [
      cap('search-files', { permissions: ['write'] }),
    ], at)).toThrow('not covered by the parent');
    expect(() => setCapabilities(state, 'empty', [
      cap('post-message'),
    ], at)).toThrow('not covered by the parent');
    expect(() => setCapabilities(state, 'empty', [
      cap('search-files', { permissions: [] }),
    ], at)).toThrow('at least one permission');
  });

  it('revokes a direct child the new set no longer covers, and its descendants', () => {
    let state = fixture();
    state = createGrant(state, {
      name: 'Deeper', parentId: 'researcher',
      expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [cap('search-files')],
    }, 'deeper', at);

    // The coordinator gives up search-files, which is all the researcher held.
    const next = setCapabilities(state, 'coordinator', [
      cap('create-issue'),
    ], at);

    expect(next.grants.coordinator.revokedAt).toBe(null);
    expect(next.grants.researcher.revokedAt).toBe(at);
    expect(next.grants.deeper.revokedAt).toBe(at);
    expect(next.audit[0].detail).toContain('Researcher');
  });

  it('orphans a child by narrowing path coverage, not only by giving up a resource', () => {
    let state = fixture();
    state.grants.coordinator.capabilities = [pathCap('acme/drive', { descendants: true })];
    state = createGrant(state, {
      name: 'Follower', parentId: 'coordinator', expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [pathCap('acme/drive/search-files')],
    }, 'follower', at);

    const next = setCapabilities(state, 'coordinator', [pathCap('acme/drive')], at);

    expect(next.grants.follower.revokedAt).toBe(at);
  });

  it('refuses to amend a grant that is not active', () => {
    const state = revokeGrant(fixture(), 'researcher', at);

    expect(() => setCapabilities(state, 'researcher', [], at)).toThrow('revoked or expired grant is not amended');
  });

  it('makes delegated authority ineffective when its resource leaves parent scope without revoking it', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [pathCap('acme/drive', { descendants: true })];
    state.grants.researcher.capabilities = [cap('search-files')];
    state.tokens.demo.grantId = 'researcher';

    const moved = moveResource(state, 'search-files', 'slack-tools', at);
    expect(moved.grants.researcher.revokedAt).toBe(null);
    expect(authorize(moved, demoHash, 'search-files', 'invoke', at).allowed).toBe(false);

    const returned = moveResource(moved, 'search-files', 'drive', at);
    expect(authorize(returned, demoHash, 'search-files', 'invoke', at).allowed).toBe(true);
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
      name: 'drive', parentId: 'acme',
    }, 'drive-2', at);

    expect(resourceIdAtPath(recreated.resources, 'acme/drive')).toBe('drive-2');
    expect(() => createResource(recreated, {
      name: 'anything', parentId: 'acme',
    }, 'drive', at)).toThrow('Resource drive already exists.');
  });

  it('refuses a child rooted outside its parent', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [cap('search-files')];

    expect(() => createGrant(state, {
      name: 'Escalated', parentId: 'coordinator', expiresAt,
      capabilities: [cap('post-message')],
    }, 'escalated', at)).toThrow('not covered');
  });

  it('refuses a child that widens descendants past its parent', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [cap('drive')];

    expect(() => createGrant(state, {
      name: 'Widened', parentId: 'coordinator', expiresAt,
      capabilities: [cap('drive', { descendants: true })],
    }, 'widened', at)).toThrow('not covered');

    expect(createGrant(state, {
      name: 'Narrowed', parentId: 'coordinator', expiresAt,
      capabilities: [cap('drive')],
    }, 'narrowed', at).grants.narrowed.name).toBe('Narrowed');
  });

  it('never authorizes a descendant grant beyond the grant it was delegated from', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [cap('drive')];
    // A capability that was never covered cannot appear through a stored grant either.
    state.grants.researcher.capabilities = [cap('post-message')];
    state.tokens.demo.grantId = 'researcher';

    expect(authorize(state, demoHash, 'post-message', 'invoke', at).allowed).toBe(false);
  });

  it('cascades ancestor revocation', () => {
    const revoked = revokeGrant(fixture(), 'coordinator', at);
    expect(revoked.grants.coordinator.revokedAt).toBe(at);
    expect(revoked.grants.researcher.revokedAt).toBe(at);
  });
});

const resourceRecord = (id: string, parentId: string | null): Resource =>
  ({ id, parentId, name: id, deletedAt: null });

/** A state whose resource tree contains a cycle, which no command can produce. */
function cyclicResources() {
  return { alpha: resourceRecord('alpha', 'beta'), beta: resourceRecord('beta', 'alpha') };
}

/** A state whose grant tree is broken in the given way, reachable only by construction. */
function brokenGrants(shape: 'cycle' | 'missing-parent'): State {
  const state = fixture();
  state.grants.coordinator.parentId = shape === 'cycle' ? 'researcher' : 'ghost';
  state.tokens.demo.grantId = 'researcher';
  return state;
}

const token = (overrides: Partial<Token> = {}): Token => ({
  id: 'second', grantId: 'researcher', label: 'second', hash: 'second-hash',
  expiresAt: null, revokedAt: null, ...overrides,
});

describe('structural guards', () => {
  it('refuses to walk a resource tree that contains a cycle', () => {
    expect(() => isWithin(cyclicResources(), 'alpha', 'nowhere')).toThrow('Resource tree contains a cycle.');
    expect(() => resourcePath(cyclicResources(), 'alpha')).toThrow('Resource tree contains a cycle.');
    expect(tryResourcePath(cyclicResources(), 'alpha')).toBe(null);
  });

  it('refuses to walk a grant chain that contains a cycle or names a grant that is gone', () => {
    expect(() => authorize(brokenGrants('cycle'), demoHash, 'search-files', 'invoke', at))
      .toThrow('Grant tree contains a cycle.');
    expect(() => authorize(brokenGrants('missing-parent'), demoHash, 'search-files', 'invoke', at))
      .toThrow('Grant ghost does not exist.');
  });

  it('reports a resource whose parent record is gone', () => {
    const state = fixture();
    delete state.resources.drive;

    expect(stateIntegrity(state)).toContain('Resource search-files refers to missing parent drive.');
  });

  it('reads a resource as live only while it holds no deletion time', () => {
    expect(isLive(undefined)).toBe(false);
    expect(isLive(resourceRecord('alpha', null))).toBe(true);
    expect(isLive({ ...resourceRecord('alpha', null), deletedAt: at })).toBe(false);
    expect(liveResources(cyclicResources()).map((item) => item.id)).toEqual(['alpha', 'beta']);
  });
});

describe('paths', () => {
  it('normalizes a path by dropping empty and padded segments', () => {
    expect(normalizePath('/acme// drive /')).toBe('acme/drive');
    expect(normalizePath('')).toBe('');
  });

  it('names the root when a required path resolves to no resource at all', () => {
    expect(requireResourceId(fixture().resources, 'acme/drive')).toBe('drive');
    expect(() => requireResourceId(fixture().resources, '')).toThrow('No resource exists at /.');
  });
});

describe('coverage of one capability by another', () => {
  it('requires target containment and a permission subset', () => {
    const { resources } = fixture();

    expect(covers(cap('drive', { descendants: true }), cap('search-files'), resources)).toBe(true);
    expect(covers(cap('drive', { descendants: true }), cap('post-message'), resources)).toBe(false);
    expect(covers(cap('drive'), cap('search-files'), resources)).toBe(false);
    expect(covers(cap('drive'), cap('drive'), resources)).toBe(true);
    expect(covers(cap('drive'), cap('drive', { permissions: ['write'] }), resources)).toBe(false);
  });

  it('compares two path targets lexically even while the child path is empty', () => {
    const { resources } = fixture();

    expect(covers(pathCap('/acme/', { descendants: true }), pathCap('acme/future/tool'), resources)).toBe(true);
    expect(covers(pathCap('acme'), pathCap('acme', { descendants: true }), resources)).toBe(false);
    expect(covers(pathCap('acme/drive', { descendants: true }), pathCap('acme/slack'), resources)).toBe(false);
    expect(covers(pathCap('acme/drive'), cap('drive'), resources)).toBe(true);
  });
});

describe('creating a resource', () => {
  const input = { name: 'notes', parentId: 'drive' };

  it('requires a name that is present and holds no separator', () => {
    expect(() => createResource(fixture(), { ...input, name: '  ' }, 'notes', at)).toThrow('Resource name is required.');
    expect(() => createResource(fixture(), { ...input, name: 'a/b' }, 'notes', at))
      .toThrow('Resource names cannot contain slashes.');
  });

  it('requires a parent that exists and is not deleted', () => {
    expect(() => createResource(fixture(), { ...input, parentId: 'ghost' }, 'notes', at))
      .toThrow('Parent resource does not exist.');

    const deleted = deleteResource(fixture(), 'drive', at);
    expect(() => createResource(deleted, input, 'notes', at)).toThrow('Parent resource does not exist.');
  });

  it('refuses a second resource at the same path and trims the name it stores', () => {
    expect(() => createResource(fixture(), { ...input, name: 'search-files' }, 'notes', at))
      .toThrow('A resource already exists at that path.');
    expect(createResource(fixture(), { ...input, name: ' notes ' }, 'notes', at).resources.notes.name).toBe('notes');
  });

  it('creates a root resource, which has no parent to check', () => {
    const created = createResource(fixture(), { ...input, name: 'other', parentId: null }, 'other', at);

    expect(resourceIdAtPath(created.resources, 'other')).toBe('other');
  });
});

describe('moving a resource', () => {
  it('requires a destination that exists, and allows a move to the root', () => {
    expect(() => moveResource(fixture(), 'search-files', 'ghost', at)).toThrow('Parent resource does not exist.');
    expect(moveResource(fixture(), 'drive', null, at).resources.drive.parentId).toBe(null);
  });

  it('refuses a move into the resource itself or into its own descendant', () => {
    expect(() => moveResource(fixture(), 'drive', 'drive', at)).toThrow('A resource cannot move inside itself.');
    expect(() => moveResource(fixture(), 'drive', 'search-files', at)).toThrow('A resource cannot move inside itself.');
  });

  it('keeps ID targets on the resource and path targets at their location', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [cap('drive', { descendants: true })];

    const moved = moveResource(state, 'drive', 'slack-tools', at);
    expect(authorize(moved, demoHash, 'search-files', 'invoke', at).allowed).toBe(true);
    expect(resourceIdAtPath(moved.resources, 'acme/drive/search-files')).toBe(null);
    expect(moved.grants.coordinator.revokedAt).toBe(null);

    const pathState = fixture();
    pathState.grants.coordinator.capabilities = [pathCap('acme/drive/search-files')];
    const pathMoved = moveResource(pathState, 'search-files', 'slack-tools', at);
    expect(authorize(pathMoved, demoHash, 'search-files', 'invoke', at).allowed).toBe(false);
  });
});

describe('deleting a resource', () => {
  it('refuses to delete a record that is already a tombstone', () => {
    const deleted = deleteResource(fixture(), 'drive', at);

    expect(() => deleteResource(deleted, 'drive', at)).toThrow('Resource does not exist.');
  });

  it('leaves grants active and lets a path target apply to a replacement resource', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [
      cap('search-files'),
      pathCap('acme/drive/search-files'),
      cap('create-issue'),
    ];

    const deleted = deleteResource(state, 'search-files', at);
    expect(deleted.grants.coordinator.revokedAt).toBe(null);
    expect(authorize(deleted, demoHash, 'create-issue', 'invoke', at).allowed).toBe(true);

    const recreated = createResource(deleted, { name: 'search-files', parentId: 'drive' }, 'search-files-2', at);
    expect(authorize(recreated, demoHash, 'search-files-2', 'invoke', at).allowed).toBe(true);
  });
});

describe('creating a grant', () => {
  const input = {
    name: 'Child', parentId: 'coordinator',
    expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
  };

  it('requires a name', () => {
    expect(() => createGrant(fixture(), { ...input, name: ' ' }, 'child', at))
      .toThrow('Grant name is required.');
  });

  it('requires resource targets to be live and every capability to carry a permission', () => {
    const entry = cap('ghost');

    expect(() => createGrant(fixture(), { ...input, capabilities: [entry] }, 'child', at))
      .toThrow('Capability resource does not exist.');
    expect(() => createGrant(fixture(), {
      ...input, capabilities: [cap('search-files', { permissions: [] })],
    }, 'child', at)).toThrow('Select at least one permission.');
  });

  it('normalizes path targets and allows them to name empty locations', () => {
    const created = createGrant(fixture(), {
      ...input,
      parentId: null,
      capabilities: [pathCap('/acme//future /')],
    }, 'path-root', at);

    expect(created.grants['path-root'].capabilities[0].target).toEqual({ type: 'path', path: 'acme/future' });
    expect(() => createGrant(fixture(), {
      ...input, parentId: null, capabilities: [pathCap(' / ')],
    }, 'empty-path', at)).toThrow('Capability path is required.');
  });

  it('requires a parent that is present and active', () => {
    expect(() => createGrant(fixture(), { ...input, parentId: 'ghost' }, 'child', at))
      .toThrow('Parent grant is missing or inactive.');
    expect(() => createGrant(revokeGrant(fixture(), 'coordinator', at), input, 'child', at))
      .toThrow('Parent grant is missing or inactive.');
  });

  it('refuses an expiration that outlasts the parent, including no expiration at all', () => {
    expect(() => createGrant(fixture(), { ...input, expiresAt: '2028-01-01T00:00:00.000Z' }, 'child', at))
      .toThrow('Child expiration must not exceed its parent.');
    expect(() => createGrant(fixture(), { ...input, expiresAt: null }, 'child', at))
      .toThrow('Child expiration must not exceed its parent.');
  });

  it('creates a root grant, which has no parent to downscope against', () => {
    const created = createGrant(fixture(), { ...input, parentId: null, expiresAt: null }, 'root', at);

    expect(created.grants.root.parentId).toBe(null);
    expect(created.audit[0].action).toBe('grant.create');
    expect(createGrant(fixture(), input, 'child', at).audit[0].action).toBe('grant.delegate');
  });
});

describe('setting capabilities', () => {
  it('requires a grant that exists', () => {
    expect(() => setCapabilities(fixture(), 'ghost', [], at)).toThrow('Grant does not exist.');
  });

  it('requires each resource target to name a live resource while path targets may be empty', () => {
    const deleted = deleteResource(fixture(), 'slack', at);

    expect(() => setCapabilities(deleted, 'coordinator', [{
      target: { type: 'resource', resourceId: 'post-message' }, permissions: ['invoke'], descendants: false,
    }], at)).toThrow('Capability resource does not exist.');
    expect(setCapabilities(deleted, 'coordinator', [pathCap('acme/slack/post-message')], at)
      .grants.coordinator.capabilities[0].target).toEqual({ type: 'path', path: 'acme/slack/post-message' });
  });

  it('requires a parent that is present and active', () => {
    const state = fixture();
    state.grants.researcher.parentId = 'ghost';

    expect(() => setCapabilities(state, 'researcher', [], at)).toThrow('Parent grant is missing or inactive.');
  });
});

describe('tokens', () => {
  it('records a token against an active grant only', () => {
    const recorded = recordToken(fixture(), token(), at);

    expect(recorded.tokens.second.grantId).toBe('researcher');
    expect(recorded.audit[0].detail).toBe('Issued second.');
    expect(() => recordToken(fixture(), token({ grantId: 'ghost' }), at)).toThrow('Grant is missing or inactive.');
    expect(() => recordToken(revokeGrant(fixture(), 'researcher', at), token(), at))
      .toThrow('Grant is missing or inactive.');
  });

  it('revokes a token once and keeps the time of the first revocation', () => {
    const revoked = revokeToken(fixture(), 'demo', at);
    const later = '2026-08-23T00:00:00.000Z';

    expect(revoked.tokens.demo.revokedAt).toBe(at);
    expect(revokeToken(revoked, 'demo', later).tokens.demo.revokedAt).toBe(at);
    expect(() => revokeToken(fixture(), 'ghost', at)).toThrow('Token does not exist.');
  });

  it('requires a grant that exists to revoke', () => {
    expect(() => revokeGrant(fixture(), 'ghost', at)).toThrow('Grant does not exist.');
  });
});

describe('authorization decisions', () => {
  it('denies a token it does not know, and one that is expired or revoked', () => {
    expect(authorize(fixture(), 'unknown-hash', 'search-files', 'invoke', at).detail)
      .toBe('Token is unknown, expired, or revoked.');
    expect(authorize(fixture(), demoHash, 'search-files', 'invoke', '2028-01-01T00:00:00.000Z').allowed).toBe(false);
  });

  it('denies a chain that holds a revoked grant', () => {
    const state = fixture();
    state.tokens.demo.grantId = 'researcher';
    const revoked = revokeGrant(state, 'researcher', at);
    const decision = authorize(revoked, demoHash, 'search-files', 'invoke', at);

    expect(decision.detail).toBe('A grant in the delegation chain is expired or revoked.');
    expect(decision.lineage).toEqual(['researcher', 'coordinator']);
  });

  it('reaches a descendant resource through an entry that includes descendants', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [cap('drive', { descendants: true })];

    expect(authorize(state, demoHash, 'read-file', 'invoke', at).allowed).toBe(true);
    expect(authorize(state, demoHash, 'post-message', 'invoke', at).allowed).toBe(false);
  });
});

describe('inspecting the authority behind a token', () => {
  it('reports the effective permissions of a valid token', () => {
    const view = inspectAuthority(fixture(), demoHash, at);

    expect(view.valid).toBe(true);
    expect(view.detail).toBe('2 resources are visible through Coordinator.');
    expect(view.lineage).toEqual(['coordinator']);
    expect(view.permissions).toEqual({ 'search-files': ['invoke'], 'create-issue': ['invoke'] });
  });

  it('reports no authority for a token it does not know or a chain that is broken', () => {
    expect(inspectAuthority(fixture(), 'unknown-hash', at)).toEqual({
      valid: false, detail: 'Token is unknown, expired, or revoked.', grantId: null, lineage: [], permissions: {},
    });

    const state = fixture();
    state.tokens.demo.grantId = 'researcher';
    const view = inspectAuthority(revokeGrant(state, 'coordinator', at), demoHash, at);

    expect(view.valid).toBe(false);
    expect(view.detail).toBe('A grant in the delegation chain is expired or revoked.');
    expect(view.permissions).toEqual({});
  });

  it('lists every permission the contract understands', () => {
    expect(permissions).toEqual(['read', 'write', 'delete', 'move', 'invoke']);
  });
});

describe('minting a stable ID', () => {
  it('derives a readable ID from a name and never reuses one that is taken', () => {
    expect(availableId(fixture(), 'New Thing')).toBe('new-thing');
    expect(availableId(fixture(), 'drive')).toBe('drive-2');
    expect(availableId(fixture(), '!!!')).toBe('resource');
  });
});
