import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  authorize, authorizeLineage, availableGrantId, availableId, covers, createAtPath, createGrant, createGrantAtPath, createResource,
  deleteResource, grantId, grantIdAtPath, InvalidParentError, isLive, isWithin, liveResources,
  updateResource, normalizePath, permissions, recordToken, requireResourceId, resourceId, resourceIdAtPath,
  resolveBearer, resourcePath, revokeGrant, revokeToken, RgapError, setBindings,
  stateIntegrity, tryResourcePath, tokenHash, tokenId, type GrantBinding, type GrantBindingConfig, type CreateGrantInput,
  type GrantId, type Resource, type ResourceId, type State, type Token,
} from './domain';
import { fixture } from './fixture';

const at = '2026-08-22T00:00:00.000Z';
const demo = tokenHash('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3');
const r = resourceId;
const g = grantId;
const cap = (
  id: string,
  over: Partial<GrantBindingConfig> = {},
): GrantBinding => ({
  id: r(id),
  permissions: ['invoke'],
  ...over,
});
const storedCap = (id: string): GrantBinding => cap(id, { permissions: ['read', 'invoke'] });

describe('RGAP domain', () => {
  it('authorizes only resources present in the complete grant chain', () => {
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

  it('reports missing executable binding resources and grant lineage', () => {
    const state = fixture();
    state.resources['search-files'].executable = {
      runtime: 'test',
      input: {},
      bind: {
        source: {
          resourceId: r('missing-bound-resource'),
          grantLineage: [g('missing-binding-grant')],
        },
      },
    };
    expect(stateIntegrity(state)).toEqual([
      'Executable search-files binding source refers to missing resource missing-bound-resource.',
      'Executable search-files binding source refers to missing grant missing-binding-grant.',
    ]);

    state.resources['search-files'].executable!.bind = {
      valid: {
        resourceId: r('read-file'),
        grantLineage: [g('coordinator')],
      },
      admin: {
        resourceId: r('drive'),
        grantLineage: null,
      },
    };
    expect(stateIntegrity(state)).toEqual([]);
  });

  it('reports an executable resource that has children', () => {
    const state = fixture();
    state.resources.drive.executable = { runtime: 'test', input: {}, bind: {} };
    expect(stateIntegrity(state)).toContain('Executable resource drive has children.');
  });

  it('rejects delegation that expands permission', () => {
    const state = fixture();
    state.grants.coordinator.bindings = [cap('drive', { permissions: ['read'] })];

    expect(() => createGrant(state, {
      name: 'Writer', parentId: g('coordinator'), expiresAt: '2027-01-01T00:00:00.000Z',
      bindings: [cap('read-file', { permissions: ['write'] })],
    }, g('writer'), at)).toThrow('not covered');
  });

  it('creates a grant that reaches nothing until its bindings are set', () => {
    const created = createGrant(fixture(), {
      name: 'Empty', parentId: g('coordinator'),
      expiresAt: '2027-01-01T00:00:00.000Z', bindings: [],
    }, g('empty'), at);

    expect(created.grants.empty.bindings).toEqual([]);

    const withEntry = setBindings(created, g('empty'), [
      cap('search-files'),
    ], at);
    expect(withEntry.grants.empty.bindings).toHaveLength(1);
  });

  it('holds a set to the same downscoping proof as issue', () => {
    const state = createGrant(fixture(), {
      name: 'Empty', parentId: g('coordinator'),
      expiresAt: '2027-01-01T00:00:00.000Z', bindings: [],
    }, g('empty'), at);

    // The coordinator holds `invoke` on search-files, so neither a wider permission nor a
    // resource it does not reach may be set on a grant delegated from it.
    expect(() => setBindings(state, g('empty'), [
      cap('search-files', { permissions: ['write'] }),
    ], at)).toThrow('not covered by the parent');
    expect(() => setBindings(state, g('empty'), [
      cap('post-message'),
    ], at)).toThrow('not covered by the parent');
    expect(() => setBindings(state, g('empty'), [
      cap('search-files', { permissions: [] }),
    ], at)).toThrow('at least one permission');
  });

  it('revokes a direct child the new set no longer covers, and its descendants', () => {
    let state = fixture();
    state = createGrant(state, {
      name: 'Deeper', parentId: g('researcher'),
      expiresAt: '2027-01-01T00:00:00.000Z',
      bindings: [cap('search-files')],
    }, g('deeper'), at);

    // The coordinator gives up search-files, which is all the researcher held.
    const next = setBindings(state, g('coordinator'), [
      cap('create-issue'),
    ], at);

    expect(next.grants.coordinator.revokedAt).toBe(null);
    expect(next.grants.researcher.revokedAt).toBe(at);
    expect(next.grants.deeper.revokedAt).toBe(at);
    expect(next.audit[0].detail).toContain('Researcher');
  });

  it('orphans a child when its target is outside the parent target', () => {
    let state = fixture();
    state.grants.coordinator.bindings = [storedCap('drive')];
    state = createGrant(state, {
      name: 'Follower', parentId: g('coordinator'), expiresAt: '2027-01-01T00:00:00.000Z',
      bindings: [cap('search-files')],
    }, g('follower'), at);

    const next = setBindings(state, g('coordinator'), [cap('slack')], at);

    expect(next.grants.follower.revokedAt).toBe(at);
  });

  it('refuses to amend a grant that is not active', () => {
    const state = revokeGrant(fixture(), g('researcher'), at);

    expect(() => setBindings(state, g('researcher'), [], at)).toThrow('revoked or expired grant is not amended');
  });

  it('makes delegated authority ineffective when its resource leaves parent scope without revoking it', () => {
    const state = fixture();
    state.grants.coordinator.bindings = [storedCap('drive')];
    state.grants.researcher.bindings = [storedCap('search-files')];
    state.tokens.demo.grantId = g('researcher');

    const moved = updateResource(state, r('search-files'), { parentId: r('slack-tools') }, at);
    expect(moved.grants.researcher.revokedAt).toBe(null);
    expect(authorize(moved, demo, r('search-files'), 'invoke', at).allowed).toBe(false);

    const returned = updateResource(moved, r('search-files'), { parentId: r('drive') }, at);
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
    expect(() => updateResource(deleted, r('drive'), { parentId: r('acme') }, at)).toThrow('Resource does not exist.');
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
    state.grants.coordinator.bindings = [storedCap('search-files')];

    expect(() => createGrant(state, {
      name: 'Escalated', parentId: g('coordinator'), expiresAt,
      bindings: [cap('post-message')],
    }, g('escalated'), at)).toThrow('not covered');
  });

  it('covers a child rooted at or under its parent', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.bindings = [storedCap('drive')];

    expect(createGrant(state, {
      name: 'Nested', parentId: g('coordinator'), expiresAt,
      bindings: [cap('search-files')],
    }, g('nested'), at).grants.nested.name).toBe('Nested');
  });

  it('never authorizes a descendant grant beyond the grant it was delegated from', () => {
    const state = fixture();
    const expiresAt = state.grants.coordinator.expiresAt;
    state.grants.coordinator.bindings = [storedCap('drive')];
    // A resource that was never covered cannot appear through a stored grant either.
    state.grants.researcher.bindings = [storedCap('post-message')];
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
  ({ id: r(id), parentId: parent ? r(parent) : null, name: id, deletedAt: null, executable: null });

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

describe('coverage of one resource by another', () => {
  it('requires target containment and a permission subset', () => {
    const { resources } = fixture();

    expect(covers(cap('drive'), cap('search-files'), resources)).toBe(true);
    expect(covers(cap('drive'), cap('post-message'), resources)).toBe(false);
    expect(covers(cap('search-files'), cap('drive'), resources)).toBe(false);
    expect(covers(cap('drive'), cap('drive'), resources)).toBe(true);
    expect(covers(cap('drive'), cap('drive', { permissions: ['write'] }), resources)).toBe(false);
  });

  it('requires both targets to be live', () => {
    const { resources } = fixture();

    expect(covers(cap('ghost'), cap('search-files'), resources)).toBe(false);
    expect(covers(cap('drive'), cap('ghost'), resources)).toBe(false);
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

    const executableParent = fixture();
    executableParent.resources['search-files'].executable = { runtime: 'test', input: {}, bind: {} };
    expect(() => createResource(
      executableParent,
      { ...input, parentId: r('search-files') },
      r('notes'),
      at,
    )).toThrow('Executable resources cannot contain children.');
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

describe('creating a resource at a path', () => {
  it('materializes missing prefixes and returns a state whose leaf occupies the path', () => {
    const created = createAtPath(fixture(), 'acme/platform/docs/design', null, at);

    expect(resourceIdAtPath(created.resources, 'acme/platform/docs/design')).toBe('design');
    expect(created.resources.platform.parentId).toBe('acme');
    expect(created.resources.docs.parentId).toBe('platform');
    expect(created.resources.design.parentId).toBe('docs');
    expect(created.resources.design.name).toBe('design');
    expect(created.audit.filter((event) => event.action === 'resource.create').map((event) => event.target))
      .toEqual(['design', 'docs', 'platform']);
  });

  it('reuses live prefixes and refuses an occupied leaf', () => {
    const created = createAtPath(fixture(), 'acme/drive/notes', null, at);

    expect(resourceIdAtPath(created.resources, 'acme/drive/notes')).toBe('notes');
    expect(created.resources.notes.parentId).toBe('drive');
    expect(() => createAtPath(created, 'acme/drive/notes', null, at))
      .toThrow('A resource already exists at that path.');
  });

  it('walks a relative path from a live parent', () => {
    const created = createAtPath(fixture(), 'docs/design', r('drive'), at);

    expect(resourceIdAtPath(created.resources, 'docs/design', r('drive'))).toBe('design');
    expect(resourceIdAtPath(created.resources, 'acme/drive/docs/design')).toBe('design');
  });

  it('requires a non-empty path and a live parent when one is supplied', () => {
    expect(() => createAtPath(fixture(), '  //  ', null, at)).toThrow('Resource name is required.');
    expect(() => createAtPath(fixture(), 'notes', r('ghost'), at)).toThrow('Parent resource does not exist.');
  });

  it('does not create children under executable resources', () => {
    const state = fixture();
    state.resources['search-files'].executable = { runtime: 'test', input: {}, bind: {} };
    expect(() => createAtPath(state, 'child', r('search-files'), at))
      .toThrow('Executable resources cannot contain children.');
    expect(() => createAtPath(state, 'acme/drive/search-files/child', null, at))
      .toThrow('Executable resources cannot contain children.');
  });
});

describe('updating a resource', () => {
  it('requires a field and refuses duplicate names', () => {
    expect(() => updateResource(fixture(), r('search-files'), {}, at))
      .toThrow('Select at least one resource field');
    expect(() => updateResource(fixture(), r('search-files'), { name: ' ' }, at))
      .toThrow('Resource name is required.');
    expect(() => updateResource(fixture(), r('search-files'), { name: 'other/name' }, at))
      .toThrow('Resource names cannot contain slashes.');
    expect(() => updateResource(fixture(), r('read-file'), { name: 'search-files' }, at))
      .toThrow('A resource already exists at that path.');
  });

  it('requires a destination that exists, and allows a move to the root', () => {
    expect(() => updateResource(fixture(), r('search-files'), { parentId: r('ghost') }, at)).toThrow('Parent resource does not exist.');
    expect(updateResource(fixture(), r('drive'), { parentId: null }, at).resources.drive.parentId).toBe(null);
  });

  it('refuses a move into the resource itself or into its own descendant', () => {
    expect(() => updateResource(fixture(), r('drive'), { parentId: r('drive') }, at)).toThrow('A resource cannot move inside itself.');
    expect(() => updateResource(fixture(), r('drive'), { parentId: r('search-files') }, at)).toThrow('A resource cannot move inside itself.');
  });

  it('requires the destination to be a folder', () => {
    const state = fixture();
    state.resources['create-issue'].executable = { runtime: 'test', input: {}, bind: {} };
    expect(() => updateResource(state, r('search-files'), { parentId: r('create-issue') }, at))
      .toThrow('Executable resources cannot contain children.');
  });

  it('keeps grant targets on the resource when it moves', () => {
    const state = fixture();
    state.grants.coordinator.bindings = [storedCap('drive')];

    const moved = updateResource(state, r('drive'), { parentId: r('slack-tools') }, at);
    expect(authorize(moved, demo, r('search-files'), 'invoke', at).allowed).toBe(true);
    expect(resourceIdAtPath(moved.resources, 'acme/drive/search-files')).toBe(null);
    expect(moved.grants.coordinator.revokedAt).toBe(null);
  });
});

describe('deleting a resource', () => {
  it('refuses to delete a record that is already a tombstone', () => {
    const deleted = deleteResource(fixture(), r('drive'), at);

    expect(() => deleteResource(deleted, r('drive'), at)).toThrow('Resource does not exist.');
  });

  it('leaves grants active without transferring authority to a replacement resource', () => {
    const state = fixture();
    state.grants.coordinator.bindings = [
      storedCap('search-files'),
      storedCap('create-issue'),
    ];

    const deleted = deleteResource(state, r('search-files'), at);
    expect(deleted.grants.coordinator.revokedAt).toBe(null);
    expect(authorize(deleted, demo, r('create-issue'), 'invoke', at).allowed).toBe(true);

    const recreated = createResource(deleted, { name: 'search-files', parentId: r('drive') }, r('search-files-2'), at);
    expect(authorize(recreated, demo, r('search-files-2'), 'invoke', at).allowed).toBe(false);
  });
});

describe('creating a grant', () => {
  const input = {
    name: 'Child', parentId: g('coordinator'),
    expiresAt: '2027-01-01T00:00:00.000Z', bindings: [],
  };

  it('requires a name', () => {
    expect(() => createGrant(fixture(), { ...input, name: ' ' }, g('child'), at))
      .toThrow('Grant name is required.');
  });

  it('requires binding targets to be live and every binding to carry a permission', () => {
    const entry = cap('ghost');

    expect(() => createGrant(fixture(), { ...input, bindings: [entry] }, g('child'), at))
      .toThrow('Grant binding resource does not exist.');
    expect(() => createGrant(fixture(), {
      ...input, bindings: [cap('search-files', { permissions: [] })],
    }, g('child'), at)).toThrow('Select at least one permission.');
  });

  it('requires exactly one resource ID target per binding', () => {
    expect(() => createGrant(fixture(), {
      ...input, parentId: null,
      bindings: [{ path: 'acme/future', permissions: ['invoke'] } as unknown as GrantBinding],
    }, g('path'), at)).toThrow('Grant binding must name one resource id.');
    expect(() => createGrant(fixture(), {
      ...input, parentId: null,
      bindings: [{ id: r('search-files'), path: 'acme/drive', permissions: ['invoke'] } as unknown as GrantBinding],
    }, g('both'), at)).toThrow('Grant binding must name one resource id.');
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

  it('requires a stored name to be one segment and unique among active siblings', () => {
    expect(() => createGrant(fixture(), { ...input, name: 'child/path' }, g('child'), at))
      .toThrow('Grant names cannot contain slashes.');
    expect(() => createGrant(fixture(), {
      ...input, name: 'Researcher', parentId: g('coordinator'),
    }, g('child'), at)).toThrow('A grant already exists at that path.');
  });
});

describe('creating a grant at a path', () => {
  const write = {
    name: 'company/team/employee',
    bindings: [] as GrantBinding[],
    expiresAt: null,
  };

  it('materializes every missing segment and returns a resolvable leaf', () => {
    const created = createGrantAtPath(fixture(), write, null, at);
    const leaf = grantIdAtPath(created.grants, write.name, null, at);

    expect(leaf).toBe(g('employee'));
    expect(created.grants.company).toMatchObject({ name: 'company', parentId: null });
    expect(created.grants.team).toMatchObject({ name: 'team', parentId: g('company') });
    expect(created.grants.employee).toMatchObject({ name: 'employee', parentId: g('team') });
    expect(created.audit.slice(0, 3).map(({ action }) => action))
      .toEqual(['grant.delegate', 'grant.delegate', 'grant.create']);
  });

  it('reuses active prefixes and creates a relative path from a parent', () => {
    const created = createGrantAtPath(fixture(), {
      ...write,
      name: 'Researcher/assistant',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }, g('coordinator'), at);

    expect(grantIdAtPath(created.grants, 'Researcher/assistant', g('coordinator'), at)).toBe(g('assistant'));
    expect(created.grants.assistant.parentId).toBe(g('researcher'));
    expect(() => createGrantAtPath(created, {
      ...write,
      name: 'Researcher/assistant',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }, g('coordinator'), at)).toThrow('A grant already exists at that path.');
  });

  it('requires a non-empty path and an active parent', () => {
    expect(() => createGrantAtPath(fixture(), { ...write, name: ' / ' }, null, at))
      .toThrow('Grant name is required.');
    expect(() => createGrantAtPath(fixture(), write, g('ghost'), at))
      .toThrow('Parent grant does not exist.');
    expect(grantIdAtPath(fixture().grants, ' / ', null, at)).toBeNull();
    expect(grantIdAtPath(fixture().grants, 'missing', null, at)).toBeNull();
  });

  it('mints readable unused grant IDs without changing stored names', () => {
    const state = fixture();
    expect(availableGrantId(state, 'Writer Grant')).toBe(g('writer-grant'));
    state.grants['writer-grant'] = {
      id: g('writer-grant'), name: 'Writer Grant', parentId: null,
      bindings: [], expiresAt: null, revokedAt: null,
    };
    expect(availableGrantId(state, 'Writer Grant')).toBe(g('writer-grant-2'));
    expect(availableGrantId(state, '---')).toBe(g('grant'));
  });
});

describe('setting bindings', () => {
  it('requires a grant that exists', () => {
    expect(() => setBindings(fixture(), g('ghost'), [], at)).toThrow('Grant does not exist.');
  });

  it('requires each resource target to name a live resource', () => {
    const deleted = deleteResource(fixture(), r('slack'), at);

    expect(() => setBindings(deleted, g('coordinator'), [cap('post-message')], at))
      .toThrow('Grant binding resource does not exist.');
  });

  it('requires a parent that is present and active', () => {
    const state = fixture();
    state.grants.researcher.parentId = g('ghost');

    expect(() => setBindings(state, g('researcher'), [], at)).toThrow(InvalidParentError);
    expect(() => setBindings(state, g('researcher'), [], at)).toThrow('Parent grant does not exist.');
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
  it('revalidates recorded grant lineage against current authority', () => {
    const recorded = [g('coordinator')];
    expect(authorizeLineage(
      fixture(),
      recorded,
      r('search-files'),
      'invoke',
      at,
    ).allowed).toBe(true);

    const revoked = revokeGrant(fixture(), g('coordinator'), at);
    expect(authorizeLineage(
      revoked,
      recorded,
      r('search-files'),
      'invoke',
      at,
    ).allowed).toBe(false);
    expect(authorizeLineage(
      fixture(),
      [g('researcher')],
      r('search-files'),
      'invoke',
      at,
    ).detail).toContain('no longer matches');
    expect(authorizeLineage(
      fixture(),
      recorded,
      r('missing'),
      'invoke',
      at,
    ).detail).toBe('Resource does not exist.');
    expect(authorizeLineage(
      fixture(),
      [],
      r('search-files'),
      'invoke',
      at,
    ).detail).toBe('Binding has no grant lineage.');
    expect(authorizeLineage(
      fixture(),
      recorded,
      r('search-files'),
      'write',
      at,
    ).allowed).toBe(false);
  });

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
    state.grants.coordinator.bindings = [storedCap('drive')];

    expect(authorize(state, demo, r('read-file'), 'invoke', at).allowed).toBe(true);
    expect(authorize(state, demo, r('post-message'), 'invoke', at).allowed).toBe(false);
  });

  it('denies a permission the matching binding does not carry', () => {
    const state = fixture();
    state.grants.coordinator.bindings = [{ id: r('search-files'), permissions: ['read'] }];

    expect(authorize(state, demo, r('search-files'), 'invoke', at).allowed).toBe(false);
  });
});

describe('resolving a bearer internally', () => {
  it('returns the selected grant and active lineage', () => {
    expect(resolveBearer(fixture(), demo, at)).toEqual({
      grantId: 'coordinator',
      lineage: ['coordinator'],
    });
  });

  it('rejects an unknown bearer or inactive lineage', () => {
    expect(() => resolveBearer(fixture(), tokenHash('unknown-hash'), at))
      .toThrow('Token is unknown, expired, or revoked.');

    const state = fixture();
    state.tokens.demo.grantId = g('researcher');
    expect(() => resolveBearer(revokeGrant(state, g('coordinator'), at), demo, at))
      .toThrow('A grant in the delegation chain is expired or revoked.');
  });

  it('lists every permission the contract understands', () => {
    expect(permissions).toEqual(['read', 'write', 'invoke', 'bind', 'move', 'delete']);
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
    expectTypeOf<GrantBinding>().toEqualTypeOf<GrantBindingConfig & { id: ResourceId }>();
  });
});
