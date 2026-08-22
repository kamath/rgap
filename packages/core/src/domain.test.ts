import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  authorize, availableId, covers, createGrant, createResource, deleteResource, grantId, inspectAuthority,
  InvalidParentError, isLive, isWithin, liveResources, moveResource, normalizePath, permissions, recordToken,
  requireResourceId, resourceId, resourceIdAtPath, resourcePath, revokeGrant, revokeToken, RgapError, setCapabilities,
  stateIntegrity, tryResourcePath, tokenHash, tokenId, type Capability, type CapabilityConfig, type CreateGrantInput,
  type GrantId, type PathCapability, type Resource, type ResourceCapability, type ResourceId, type State, type Token,
} from './domain';
import { fixture } from './fixture';

const at = '2026-08-22T00:00:00.000Z';
const demo = tokenHash('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');
const r = resourceId;
const g = grantId;
const cap = (
  id: string,
  over: Partial<CapabilityConfig> = {},
): Capability => ({
  resourceId: r(id),
  permissions: ['invoke'],
  ...over,
});
const pathCap = (
  path: string,
  over: Partial<CapabilityConfig> = {},
): Capability => ({
  path,
  permissions: ['invoke'],
  ...over,
});

describe('RGAP domain', () => {
  it('authorizes only capabilities present in the complete grant chain', () => {
    expect(authorize(fixture(), demo, r('create-issue'), 'invoke', at).allowed).toBe(true);
    expect(authorize(fixture(), demo, r('post-message'), 'invoke', at).allowed).toBe(false);
  });

  it('reports a path for a deleted resource and none for a record that is gone', () => {
    const state = deleteResource(fixture(), r('search-files'), at);

    expect(tryResourcePath(state.resources, r('search-files'))).toBe('acme/drive/search-files');

    delete state.resources['search-files'];
    expect(tryResourcePath(state.resources, r('search-files'))).toBe(null);
  });

  it('walks resource arrays returned by collection queries directly', () => {
    const resources = Object.values(fixture().resources);

    expect(resourcePath(resources, r('search-files'))).toBe('acme/drive/search-files');
    expect(resourceIdAtPath(resources, 'acme/drive/read-file')).toBe('read-file');
    expect(requireResourceId(resources, 'acme/drive')).toBe('drive');
    expect(isWithin(resources, r('read-file'), r('acme'))).toBe(true);
    expect(liveResources(resources)).toHaveLength(resources.length);
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
    state.grants.coordinator.capabilities = [cap('drive', { permissions: ['read'] })];

    expect(() => createGrant(state, {
      name: 'Writer', parentId: g('coordinator'), expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [cap('read-file', { permissions: ['write'] })],
    }, g('writer'), at)).toThrow('not covered');
  });

  it('creates a grant that reaches nothing until its capabilities are set', () => {
    const created = createGrant(fixture(), {
      name: 'Empty', parentId: g('coordinator'),
      expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
    }, g('empty'), at);

    expect(created.grants.empty.capabilities).toEqual([]);

    const withEntry = setCapabilities(created, g('empty'), [
      cap('search-files'),
    ], at);
    expect(withEntry.grants.empty.capabilities).toHaveLength(1);
  });

  it('holds a set to the same downscoping proof as issue', () => {
    const state = createGrant(fixture(), {
      name: 'Empty', parentId: g('coordinator'),
      expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
    }, g('empty'), at);

    // The coordinator holds `invoke` on search-files, so neither a wider permission nor a
    // resource it does not reach may be set on a grant delegated from it.
    expect(() => setCapabilities(state, g('empty'), [
      cap('search-files', { permissions: ['write'] }),
    ], at)).toThrow('not covered by the parent');
    expect(() => setCapabilities(state, g('empty'), [
      cap('post-message'),
    ], at)).toThrow('not covered by the parent');
    expect(() => setCapabilities(state, g('empty'), [
      cap('search-files', { permissions: [] }),
    ], at)).toThrow('at least one permission');
  });

  it('revokes a direct child the new set no longer covers, and its descendants', () => {
    let state = fixture();
    state = createGrant(state, {
      name: 'Deeper', parentId: g('researcher'),
      expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [cap('search-files')],
    }, g('deeper'), at);

    // The coordinator gives up search-files, which is all the researcher held.
    const next = setCapabilities(state, g('coordinator'), [
      cap('create-issue'),
    ], at);

    expect(next.grants.coordinator.revokedAt).toBe(null);
    expect(next.grants.researcher.revokedAt).toBe(at);
    expect(next.grants.deeper.revokedAt).toBe(at);
    expect(next.audit[0].detail).toContain('Researcher');
  });

  it('orphans a child by narrowing path coverage, not only by giving up a resource', () => {
    let state = fixture();
    state.grants.coordinator.capabilities = [pathCap('acme/drive')];
    state = createGrant(state, {
      name: 'Follower', parentId: g('coordinator'), expiresAt: '2027-01-01T00:00:00.000Z',
      capabilities: [pathCap('acme/drive/search-files')],
    }, g('follower'), at);

    const next = setCapabilities(state, g('coordinator'), [pathCap('acme/slack')], at);

    expect(next.grants.follower.revokedAt).toBe(at);
  });

  it('refuses to amend a grant that is not active', () => {
    const state = revokeGrant(fixture(), g('researcher'), at);

    expect(() => setCapabilities(state, g('researcher'), [], at)).toThrow('revoked or expired grant is not amended');
  });

  it('makes delegated authority ineffective when its resource leaves parent scope without revoking it', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [pathCap('acme/drive')];
    state.grants.researcher.capabilities = [cap('search-files')];
    state.tokens.demo.grantId = g('researcher');

    const moved = moveResource(state, r('search-files'), r('slack-tools'), at);
    expect(moved.grants.researcher.revokedAt).toBe(null);
    expect(authorize(moved, demo, r('search-files'), 'invoke', at).allowed).toBe(false);

    const returned = moveResource(moved, r('search-files'), r('drive'), at);
    expect(authorize(returned, demo, r('search-files'), 'invoke', at).allowed).toBe(true);
  });

  it('resolves a path to a stable ID and refuses a path that names nothing', () => {
    const state = fixture();

    expect(resourceIdAtPath(state.resources, '/acme//drive/')).toBe('drive');
    expect(resourceIdAtPath(state.resources, 'acme/missing')).toBe(null);
    expect(resourceIdAtPath(state.resources, '')).toBe(null);
    expect(() => requireResourceId(state.resources, 'acme/missing')).toThrow('No resource exists at acme/missing.');
  });

  it('keeps a deleted resource as an unresolvable tombstone that still holds its ID', () => {
    const deleted = deleteResource(fixture(), r('drive'), at);

    expect(deleted.resources.drive.deletedAt).toBe(at);
    expect(deleted.resources['search-files'].deletedAt).toBe(at);
    expect(resourceIdAtPath(deleted.resources, 'acme/drive')).toBe(null);
    expect(authorize(deleted, demo, r('search-files'), 'invoke', at).detail).toBe('Resource does not exist.');
    expect(() => moveResource(deleted, r('drive'), r('acme'), at)).toThrow('Resource does not exist.');
  });

  it('frees a deleted name without reissuing its stable ID', () => {
    const deleted = deleteResource(fixture(), r('drive'), at);
    const recreated = createResource(deleted, {
      name: 'drive', parentId: r('acme'),
    }, r('drive-2'), at);

    expect(resourceIdAtPath(recreated.resources, 'acme/drive')).toBe('drive-2');
    expect(() => createResource(recreated, {
      name: 'anything', parentId: r('acme'),
    }, r('drive'), at)).toThrow('Resource drive already exists.');
  });

  it('refuses a child rooted outside its parent', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [cap('search-files')];

    expect(() => createGrant(state, {
      name: 'Escalated', parentId: g('coordinator'), expiresAt,
      capabilities: [cap('post-message')],
    }, g('escalated'), at)).toThrow('not covered');
  });

  it('covers a child rooted at or under its parent', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [cap('drive')];

    expect(createGrant(state, {
      name: 'Nested', parentId: g('coordinator'), expiresAt,
      capabilities: [cap('search-files')],
    }, g('nested'), at).grants.nested.name).toBe('Nested');
  });

  it('never authorizes a descendant grant beyond the grant it was delegated from', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.capabilities = [cap('drive')];
    // A capability that was never covered cannot appear through a stored grant either.
    state.grants.researcher.capabilities = [cap('post-message')];
    state.tokens.demo.grantId = g('researcher');

    expect(authorize(state, demo, r('post-message'), 'invoke', at).allowed).toBe(false);
  });

  it('cascades ancestor revocation', () => {
    const revoked = revokeGrant(fixture(), g('coordinator'), at);
    expect(revoked.grants.coordinator.revokedAt).toBe(at);
    expect(revoked.grants.researcher.revokedAt).toBe(at);
  });
});

const resourceRecord = (id: string, parent: string | null): Resource =>
  ({ id: r(id), parentId: parent ? r(parent) : null, name: id, deletedAt: null });

/** A state whose resource tree contains a cycle, which no command can produce. */
function cyclicResources() {
  return { alpha: resourceRecord('alpha', 'beta'), beta: resourceRecord('beta', 'alpha') };
}

/** A state whose grant tree is broken in the given way, reachable only by construction. */
function brokenGrants(shape: 'cycle' | 'missing-parent'): State {
  const state = fixture();
  state.grants.coordinator.parentId = shape === 'cycle' ? g('researcher') : g('ghost');
  state.tokens.demo.grantId = g('researcher');
  return state;
}

const token = (overrides: Partial<Token> = {}): Token => ({
  id: tokenId('second'), grantId: g('researcher'), label: 'second', hash: tokenHash('second-hash'),
  expiresAt: null, revokedAt: null, ...overrides,
});

describe('structural guards', () => {
  it('refuses to walk a resource tree that contains a cycle', () => {
    expect(() => isWithin(cyclicResources(), r('alpha'), r('nowhere'))).toThrow('Resource tree contains a cycle.');
    expect(() => resourcePath(cyclicResources(), r('alpha'))).toThrow('Resource tree contains a cycle.');
    expect(tryResourcePath(cyclicResources(), r('alpha'))).toBe(null);
  });

  it('refuses to walk a grant chain that contains a cycle or names a grant that is gone', () => {
    expect(() => authorize(brokenGrants('cycle'), demo, r('search-files'), 'invoke', at))
      .toThrow('Grant tree contains a cycle.');
    expect(() => authorize(brokenGrants('missing-parent'), demo, r('search-files'), 'invoke', at))
      .toThrow('Grant ghost does not exist.');
    try {
      authorize(brokenGrants('missing-parent'), demo, r('search-files'), 'invoke', at);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RgapError);
      expect(error).not.toBeInstanceOf(InvalidParentError);
    }
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

    expect(covers(cap('drive'), cap('search-files'), resources)).toBe(true);
    expect(covers(cap('drive'), cap('post-message'), resources)).toBe(false);
    expect(covers(cap('search-files'), cap('drive'), resources)).toBe(false);
    expect(covers(cap('drive'), cap('drive'), resources)).toBe(true);
    expect(covers(cap('drive'), cap('drive', { permissions: ['write'] }), resources)).toBe(false);
  });

  it('compares two path targets lexically even while the child path is empty', () => {
    const { resources } = fixture();

    expect(covers(pathCap('/acme/'), pathCap('acme/future/tool'), resources)).toBe(true);
    expect(covers(pathCap('acme'), pathCap('acme'), resources)).toBe(true);
    expect(covers(pathCap('acme/drive'), pathCap('acme/slack'), resources)).toBe(false);
    expect(covers(pathCap('acme/drive'), cap('drive'), resources)).toBe(true);
  });
});

describe('creating a resource', () => {
  const input = { name: 'notes', parentId: r('drive') };

  it('requires a name that is present and holds no separator', () => {
    expect(() => createResource(fixture(), { ...input, name: '  ' }, r('notes'), at)).toThrow('Resource name is required.');
    expect(() => createResource(fixture(), { ...input, name: 'a/b' }, r('notes'), at))
      .toThrow('Resource names cannot contain slashes.');
  });

  it('requires a parent that exists and is not deleted', () => {
    expect(() => createResource(fixture(), { ...input, parentId: r('ghost') }, r('notes'), at))
      .toThrow('Parent resource does not exist.');
    try {
      createResource(fixture(), { ...input, parentId: r('ghost') }, r('notes'), at);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RgapError);
      expect(error).not.toBeInstanceOf(InvalidParentError);
    }

    const deleted = deleteResource(fixture(), r('drive'), at);
    expect(() => createResource(deleted, input, r('notes'), at)).toThrow('Parent resource does not exist.');
  });

  it('refuses a second resource at the same path and trims the name it stores', () => {
    expect(() => createResource(fixture(), { ...input, name: 'search-files' }, r('notes'), at))
      .toThrow('A resource already exists at that path.');
    expect(createResource(fixture(), { ...input, name: ' notes ' }, r('notes'), at).resources.notes.name).toBe('notes');
  });

  it('creates a root resource, which has no parent to check', () => {
    const created = createResource(fixture(), { ...input, name: 'other', parentId: null }, r('other'), at);

    expect(resourceIdAtPath(created.resources, 'other')).toBe('other');
  });
});

describe('moving a resource', () => {
  it('requires a destination that exists, and allows a move to the root', () => {
    expect(() => moveResource(fixture(), r('search-files'), r('ghost'), at)).toThrow('Parent resource does not exist.');
    expect(moveResource(fixture(), r('drive'), null, at).resources.drive.parentId).toBe(null);
  });

  it('refuses a move into the resource itself or into its own descendant', () => {
    expect(() => moveResource(fixture(), r('drive'), r('drive'), at)).toThrow('A resource cannot move inside itself.');
    expect(() => moveResource(fixture(), r('drive'), r('search-files'), at)).toThrow('A resource cannot move inside itself.');
  });

  it('keeps ID targets on the resource and path targets at their location', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [cap('drive')];

    const moved = moveResource(state, r('drive'), r('slack-tools'), at);
    expect(authorize(moved, demo, r('search-files'), 'invoke', at).allowed).toBe(true);
    expect(resourceIdAtPath(moved.resources, 'acme/drive/search-files')).toBe(null);
    expect(moved.grants.coordinator.revokedAt).toBe(null);

    const pathState = fixture();
    pathState.grants.coordinator.capabilities = [pathCap('acme/drive/search-files')];
    const pathMoved = moveResource(pathState, r('search-files'), r('slack-tools'), at);
    expect(authorize(pathMoved, demo, r('search-files'), 'invoke', at).allowed).toBe(false);
  });
});

describe('deleting a resource', () => {
  it('refuses to delete a record that is already a tombstone', () => {
    const deleted = deleteResource(fixture(), r('drive'), at);

    expect(() => deleteResource(deleted, r('drive'), at)).toThrow('Resource does not exist.');
  });

  it('leaves grants active and lets a path target apply to a replacement resource', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [
      cap('search-files'),
      pathCap('acme/drive/search-files'),
      cap('create-issue'),
    ];

    const deleted = deleteResource(state, r('search-files'), at);
    expect(deleted.grants.coordinator.revokedAt).toBe(null);
    expect(authorize(deleted, demo, r('create-issue'), 'invoke', at).allowed).toBe(true);

    const recreated = createResource(deleted, { name: 'search-files', parentId: r('drive') }, r('search-files-2'), at);
    expect(authorize(recreated, demo, r('search-files-2'), 'invoke', at).allowed).toBe(true);
  });
});

describe('creating a grant', () => {
  const input = {
    name: 'Child', parentId: g('coordinator'),
    expiresAt: '2027-01-01T00:00:00.000Z', capabilities: [],
  };

  it('requires a name', () => {
    expect(() => createGrant(fixture(), { ...input, name: ' ' }, g('child'), at))
      .toThrow('Grant name is required.');
  });

  it('requires resource targets to be live and every capability to carry a permission', () => {
    const entry = cap('ghost');

    expect(() => createGrant(fixture(), { ...input, capabilities: [entry] }, g('child'), at))
      .toThrow('Capability resource does not exist.');
    expect(() => createGrant(fixture(), {
      ...input, capabilities: [cap('search-files', { permissions: [] })],
    }, g('child'), at)).toThrow('Select at least one permission.');
  });

  it('normalizes path targets and allows them to name empty locations', () => {
    const created = createGrant(fixture(), {
      ...input,
      parentId: null,
      capabilities: [pathCap('/acme//future /')],
    }, g('path-root'), at);

    expect(created.grants['path-root'].capabilities[0]).toEqual({ path: 'acme/future', permissions: ['invoke'] });
    expect(() => createGrant(fixture(), {
      ...input, parentId: null, capabilities: [pathCap(' / ')],
    }, g('empty-path'), at)).toThrow('Capability path is required.');
    expect(() => createGrant(fixture(), {
      ...input, parentId: null, capabilities: [{ permissions: ['invoke'] } as Capability],
    }, g('neither'), at)).toThrow('Capability must name a resourceId or a path.');
    expect(() => createGrant(fixture(), {
      ...input, parentId: null,
      capabilities: [{ resourceId: r('search-files'), path: 'acme/drive', permissions: ['invoke'] } as Capability],
    }, g('both'), at)).toThrow('Capability must name a resourceId or a path.');
  });

  it('requires a parent that is present and active', () => {
    try {
      createGrant(fixture(), { ...input, parentId: g('ghost') }, g('child'), at);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidParentError);
      expect(error).toBeInstanceOf(RgapError);
      expect(error).toMatchObject({ code: 'missing_parent', message: 'Parent grant does not exist.' });
    }
    try {
      createGrant(revokeGrant(fixture(), g('coordinator'), at), input, g('child'), at);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidParentError);
      expect(error).toMatchObject({ code: 'inactive_parent', message: 'Parent grant is revoked or expired.' });
    }
  });

  it('refuses an expiration that outlasts the parent, including no expiration at all', () => {
    expect(() => createGrant(fixture(), { ...input, expiresAt: '2028-01-01T00:00:00.000Z' }, g('child'), at))
      .toThrow('Child expiration must not exceed its parent.');
    expect(() => createGrant(fixture(), { ...input, expiresAt: null }, g('child'), at))
      .toThrow('Child expiration must not exceed its parent.');
  });

  it('creates a root grant, which has no parent to downscope against', () => {
    const created = createGrant(fixture(), { ...input, parentId: null, expiresAt: null }, g('root'), at);

    expect(created.grants.root.parentId).toBe(null);
    expect(created.audit[0].action).toBe('grant.create');
    expect(createGrant(fixture(), input, g('child'), at).audit[0].action).toBe('grant.delegate');
  });
});

describe('setting capabilities', () => {
  it('requires a grant that exists', () => {
    expect(() => setCapabilities(fixture(), g('ghost'), [], at)).toThrow('Grant does not exist.');
  });

  it('requires each resource target to name a live resource while path targets may be empty', () => {
    const deleted = deleteResource(fixture(), r('slack'), at);

    expect(() => setCapabilities(deleted, g('coordinator'), [cap('post-message')], at))
      .toThrow('Capability resource does not exist.');
    expect(setCapabilities(deleted, g('coordinator'), [pathCap('acme/slack/post-message')], at)
      .grants.coordinator.capabilities[0]).toEqual({ path: 'acme/slack/post-message', permissions: ['invoke'] });
  });

  it('requires a parent that is present and active', () => {
    const state = fixture();
    state.grants.researcher.parentId = g('ghost');

    expect(() => setCapabilities(state, g('researcher'), [], at)).toThrow(InvalidParentError);
    expect(() => setCapabilities(state, g('researcher'), [], at)).toThrow('Parent grant does not exist.');
  });
});

describe('tokens', () => {
  it('records a token against an active grant only', () => {
    const recorded = recordToken(fixture(), token(), at);

    expect(recorded.tokens.second.grantId).toBe('researcher');
    expect(recorded.audit[0].detail).toBe('Issued second.');
    expect(() => recordToken(fixture(), token({ grantId: g('ghost') }), at)).toThrow('Grant is missing or inactive.');
    expect(() => recordToken(revokeGrant(fixture(), g('researcher'), at), token(), at))
      .toThrow('Grant is missing or inactive.');
  });

  it('revokes a token once and keeps the time of the first revocation', () => {
    const revoked = revokeToken(fixture(), tokenId('demo'), at);
    const later = '2026-08-23T00:00:00.000Z';

    expect(revoked.tokens.demo.revokedAt).toBe(at);
    expect(revokeToken(revoked, tokenId('demo'), later).tokens.demo.revokedAt).toBe(at);
    expect(() => revokeToken(fixture(), tokenId('ghost'), at)).toThrow('Token does not exist.');
  });

  it('requires a grant that exists to revoke', () => {
    expect(() => revokeGrant(fixture(), g('ghost'), at)).toThrow('Grant does not exist.');
  });
});

describe('authorization decisions', () => {
  it('denies a token it does not know, and one that is expired or revoked', () => {
    expect(authorize(fixture(), tokenHash('unknown-hash'), r('search-files'), 'invoke', at).detail)
      .toBe('Token is unknown, expired, or revoked.');
    expect(authorize(fixture(), demo, r('search-files'), 'invoke', '2028-01-01T00:00:00.000Z').allowed).toBe(false);
  });

  it('denies a chain that holds a revoked grant', () => {
    const state = fixture();
    state.tokens.demo.grantId = g('researcher');
    const revoked = revokeGrant(state, g('researcher'), at);
    const decision = authorize(revoked, demo, r('search-files'), 'invoke', at);

    expect(decision.detail).toBe('A grant in the delegation chain is expired or revoked.');
    expect(decision.lineage).toEqual(['researcher', 'coordinator']);
  });

  it('reaches a descendant resource through the target\'s subtree', () => {
    const state = fixture();
    state.grants.coordinator.capabilities = [cap('drive')];

    expect(authorize(state, demo, r('read-file'), 'invoke', at).allowed).toBe(true);
    expect(authorize(state, demo, r('post-message'), 'invoke', at).allowed).toBe(false);
  });
});

describe('inspecting the authority behind a token', () => {
  it('reports the effective permissions of a valid token', () => {
    const view = inspectAuthority(fixture(), demo, at);

    expect(view.valid).toBe(true);
    expect(view.detail).toBe('2 resources are visible through Coordinator.');
    expect(view.lineage).toEqual(['coordinator']);
    expect(view.permissions).toEqual({ 'search-files': ['invoke'], 'create-issue': ['invoke'] });
  });

  it('reports no authority for a token it does not know or a chain that is broken', () => {
    expect(inspectAuthority(fixture(), tokenHash('unknown-hash'), at)).toEqual({
      valid: false, detail: 'Token is unknown, expired, or revoked.', grantId: null, lineage: [], permissions: {},
    });

    const state = fixture();
    state.tokens.demo.grantId = g('researcher');
    const view = inspectAuthority(revokeGrant(state, g('coordinator'), at), demo, at);

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

describe('identity brands', () => {
  it('keeps resource, grant, and token identities from being assigned to one another', () => {
    expectTypeOf<CreateGrantInput['parentId']>().toEqualTypeOf<GrantId | null>();
    expectTypeOf<ResourceId>().not.toEqualTypeOf<GrantId>();
    expectTypeOf<Resource['id']>().not.toEqualTypeOf<GrantId>();
    expectTypeOf<ResourceCapability>().toEqualTypeOf<CapabilityConfig & { resourceId: ResourceId }>();
    expectTypeOf<PathCapability>().toEqualTypeOf<CapabilityConfig & { path: string }>();
    expectTypeOf<Capability>().toEqualTypeOf<ResourceCapability | PathCapability>();
  });
});
