import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  RgapError,
  RuntimeRegistry,
  resourceId,
  tokenValue,
  type InvokeRuntime,
  type RgapRepository,
  type State,
} from '@rgap/core';
import { SqliteRgapStore, type SqliteRgapStoreOptions } from './index';

const open = (options?: SqliteRgapStoreOptions) => {
  const store = new SqliteRgapStore(options);
  opened.push(store);
  return store;
};

const opened: SqliteRgapStore[] = [];
const directories: string[] = [];

const file = () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgap-sqlite-'));
  directories.push(directory);
  return join(directory, 'rgap.db');
};

afterEach(() => {
  opened.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const acme = (): State => ({
  resources: {
    acme: { id: resourceId('acme'), parentId: null, name: 'acme', deletedAt: null },
    drive: { id: resourceId('drive'), parentId: resourceId('acme'), name: 'drive', deletedAt: null },
  },
  grants: {},
  tokens: {},
  executables: {},
  audit: [],
});

const tokenRecord = (token: { id: string; grantId: string; label: string; hash: string; expiresAt: string | null; revokedAt: string | null }) =>
  ({ id: token.id, grantId: token.grantId, label: token.label, hash: token.hash, expiresAt: token.expiresAt, revokedAt: token.revokedAt });

const resourceRecord = (resource: { id: string; parentId: string | null; name: string; deletedAt: string | null }) =>
  ({ id: resource.id, parentId: resource.parentId, name: resource.name, deletedAt: resource.deletedAt });

const rootGrant = (repository: RgapRepository) =>
  repository.grants.create({ name: 'Acme admin', resources: [], expiresAt: null });

async function all<T extends { id: string }>(
  list: (query: { cursor?: string; limit?: number }) => Promise<T[]>,
) {
  const records: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ cursor, limit: 100 });
    records.push(...page);
    cursor = page.length === 100 ? page.at(-1)!.id : undefined;
  } while (cursor);
  return records;
}

async function queriedState(repository: RgapRepository): Promise<State> {
  const resources = await all((query) => repository.resources.list(query));
  const grants = await all((query) => repository.grants.list(query));
  const tokens = await all((query) => repository.tokens.list(query));
  const audit = await all((query) => repository.audit.list(query));
  return {
    resources: Object.fromEntries(resources.map((record) => [record.id, record])),
    grants: Object.fromEntries(grants.map((record) => [record.id, record])),
    tokens: Object.fromEntries(tokens.map((record) => [record.id, record])),
    executables: {},
    audit,
  };
}

const runtime = (
  bindings: Record<string, {
  kind: string;
  required?: boolean;
  }> = {},
  invoke: InvokeRuntime['invoke'] = () => undefined,
): InvokeRuntime => ({
  inputSchema: null,
  outputSchema: null,
  bindings,
  invoke,
});

const collect = async <T>(iterable: AsyncIterable<T>) => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

describe('SqliteRgapStore', () => {
  it('exposes command planes and close rather than repository commands', () => {
    const store = open();
    expectTypeOf<Extract<keyof SqliteRgapStore, keyof RgapRepository>>().toEqualTypeOf<never>();
    expect(store).not.toHaveProperty('resources');
  });

  it('round-trips a complete state through SQL', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    await grant.resources.set([
      { id: resourceId('acme'), permissions: ['read', 'write'] },
      { path: 'acme/future-tool', permissions: ['invoke'] },
    ]);
    const issued = await grant.tokens.create({ label: 'cli' });

    const state = await queriedState(repository);
    expect(state.resources.drive.parentId).toBe('acme');
    expect(state.grants[grant.id].resources).toEqual([
      { id: resourceId('acme'), permissions: ['read', 'write'] },
      { path: 'acme/future-tool', permissions: ['invoke'] },
    ]);
    expect(state.tokens[issued.id]).toEqual(tokenRecord(issued));
  });

  it('creates a complete grant path in one transaction and returns the leaf', async () => {
    const repository = open({ initialState: acme() }).admin();
    const employee = await repository.grants.create({
      name: 'company/team/employee',
      resources: [],
      expiresAt: null,
    });
    const team = await repository.grants.get(employee.parentId!);
    const company = await repository.grants.get(team.parentId!);

    expect(employee.name).toBe('employee');
    expect(team).toMatchObject({ name: 'team', parentId: company.id });
    expect(company).toMatchObject({ name: 'company', parentId: null });
    expect((await repository.grants.list()).map(({ name }) => name))
      .toEqual(['company', 'employee', 'team']);
  });

  it('persists and replaces executable associations across restart', async () => {
    const url = file();
    const implementation = runtime();
    const options = {
      url,
      initialState: acme(),
      runtimes: new RuntimeRegistry({ test: implementation, other: implementation }),
    };
    const firstStore = open(options);
    const first = firstStore.admin();
    const drive = await first.resources.get(resourceId('drive'));
    await drive.executable.set({ runtime: 'test' });
    await drive.executable.set({ runtime: 'other' });
    expect((await drive.executable.get())?.runtime).toBe('other');
    firstStore.close();

    const second = open({ ...options, initialState: undefined }).admin();
    expect(await second.executables.get(resourceId('drive'))).toEqual({
      resourceId: resourceId('drive'), runtime: 'other',
    });
    await second.executables.delete(resourceId('drive'));
    expect(await second.executables.get(resourceId('drive'))).toBeUndefined();
  });

  it('fails clearly when executable setting names an unknown runtime', async () => {
    const repository = open({ initialState: acme() }).admin();
    await expect(repository.executables.set(resourceId('drive'), { runtime: 'test' }))
      .rejects.toMatchObject({ code: 'unknown_runtime' });
  });

  it('records audit-safe invoke facts without exposing input, output, or binding kinds', async () => {
    const url = file();
    const inputMarker = 'private-invocation-input';
    const outputMarker = 'private-runtime-output';
    const implementation = runtime({ source: { kind: 'document' } }, async (context) => {
        expect(context.bindings.source).toEqual({ resourceId: resourceId('acme'), kind: 'document' });
        return outputMarker;
    });
    const options: SqliteRgapStoreOptions = {
      url,
      initialState: acme(),
      runtimes: { test: implementation },
    };
    const first = open(options).admin();
    await first.executables.set(resourceId('drive'), { runtime: 'test' });
    expect(await collect(first.invoke(resourceId('drive'), {
      input: inputMarker,
      bindings: { source: resourceId('acme') },
    }))).toEqual([{ type: 'data', value: outputMarker }, { type: 'done' }]);
    const invokeAudit = (await first.audit.list()).find(({ action }) => action === 'executable.invoke')!;
    expect(invokeAudit.detail).toContain('"runtime":"test"');
    expect(invokeAudit.detail).toContain('"result":"done"');
    expect(invokeAudit.detail).not.toContain(inputMarker);
    expect(invokeAudit.detail).not.toContain(outputMarker);
    expect(invokeAudit.detail).not.toContain('document');
  });

  it('authorizes invocation through the guarded plane while admin remains unrestricted', async () => {
    const implementation = runtime();
    const store = open({ initialState: acme(), runtimes: { test: implementation } });
    const admin = store.admin();
    await admin.executables.set(resourceId('drive'), { runtime: 'test' });
    expect(await collect(admin.invoke(resourceId('drive'), { input: {} }))).toEqual([{ type: 'done' }]);

    const grant = await rootGrant(admin);
    await grant.resources.set([{ id: resourceId('drive'), permissions: ['read'] }]);
    const { value } = await grant.tokens.create({ label: 'reader' });
    await expect(collect(store.as(value).invoke(resourceId('drive'), { input: {} })))
      .rejects.toMatchObject({ code: 'unauthorized' });

    const invoker = await admin.grants.create({
      name: 'Acme invoker', resources: [], expiresAt: null,
    });
    await invoker.resources.set([{ id: resourceId('drive'), permissions: ['invoke'] }]);
    const allowed = await invoker.tokens.create({ label: 'invoker' });
    expect(await collect(store.as(allowed.value).invoke(resourceId('drive'), { input: {} })))
      .toEqual([{ type: 'done' }]);
    const invocation = (await admin.audit.list()).find(({ action }) => action === 'executable.invoke')!;
    expect(JSON.parse(invocation.detail).grantLineageIds).toEqual([invoker.id]);
  });

  it('reads a permission set in the protocol canonical order', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    const amended = await grant.resources.set([
      { id: resourceId('acme'), permissions: ['invoke', 'delete', 'read'] },
    ]);
    expect(amended.resources[0].permissions).toEqual(['read', 'invoke', 'delete']);
  });

  it('stores path targets without a resource foreign key value', async () => {
    const url = file();
    const store = open({ url, initialState: acme() });
    const repository = store.admin();
    const grant = await rootGrant(repository);
    await grant.resources.set([
      { path: 'acme/not-created-yet', permissions: ['write'] },
    ]);
    store.close();

    const connection = new Database(url, { readonly: true });
    const row = connection.prepare(
      'select id, path from grant_resources where grant_id = ?',
    ).get(grant.id);
    connection.close();

    expect(row).toEqual({
      id: null,
      path: 'acme/not-created-yet',
    });
  });

  it('keeps a file database across repositories and seeds only an empty one', async () => {
    const url = file();
    const firstStore = open({ url, initialState: acme() });
    const first = firstStore.admin();
    const created = await (await first.resources.get(resourceId('acme'))).create({ name: 'mcp' });
    firstStore.close();

    // A database that already holds records is opened as it stands, so this initial state is not applied.
    const second = open({
      url,
      initialState: {
        resources: {}, grants: {}, tokens: {}, executables: {},
        audit: [],
      },
    }).admin();
    const state = await queriedState(second);
    expect(state.resources[created.id]).toEqual(resourceRecord(created));
    expect(Object.keys(state.resources)).toContain('acme');
  });

  it('restores the initial state on reset', async () => {
    const url = file();
    const store = open({ url, initialState: acme() });
    const repository = store.admin();
    await (await repository.resources.get(resourceId('acme'))).create({ name: 'mcp' });
    await repository.reset();
    expect(await queriedState(repository)).toEqual(acme());
  });

  it('opens an empty store with no initial state at all', async () => {
    const repository = open().admin();
    expect(await queriedState(repository)).toEqual({
      resources: {}, grants: {}, tokens: {}, executables: {},
      audit: [],
    });
  });

  it('writes nothing when a command is refused', async () => {
    const repository = open({ initialState: acme() }).admin();
    const parent = await rootGrant(repository);
    await parent.resources.set([
      { id: resourceId('drive'), permissions: ['read'] },
    ]);
    const child = await parent.create({
      name: 'Drive read', resources: [], expiresAt: null,
    });
    const before = await queriedState(repository);

    await expect(
      child.resources.set([
        { id: resourceId('acme'), permissions: ['write'] },
      ]),
    ).rejects.toThrow(RgapError);

    expect(await queriedState(repository)).toEqual(before);
  });

  it('records an authorization decision in the audit log, newest first', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    await grant.resources.set([
      { id: resourceId('acme'), permissions: ['read'] },
    ]);
    const { value } = await grant.tokens.create({ label: 'cli' });

    expect((await repository.authorize(value, resourceId('drive'), 'read')).allowed).toBe(true);
    expect((await repository.authorize(value, resourceId('drive'), 'write')).allowed).toBe(false);

    const audit = await repository.audit.list();
    expect(audit.slice(0, 2).map((event) => event.result)).toEqual(['denied', 'allowed']);
    expect(audit.every((event) => event.action.length > 0)).toBe(true);
  });

  it('reports the authority a token holds', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    await grant.resources.set([
      { id: resourceId('drive'), permissions: ['read', 'invoke'] },
    ]);
    const { value } = await grant.tokens.create({ label: 'cli' });

    const authority = await repository.inspectToken(value);
    expect(authority.valid).toBe(true);
    expect(authority.permissions.drive).toEqual(['read', 'invoke']);
    expect((await repository.inspectToken(tokenValue('rgap_unknown'))).valid).toBe(false);
  });

  it('moves, deletes, and revokes', async () => {
    const repository = open({ initialState: acme() }).admin();
    const moved = await (await repository.resources.get(resourceId('drive'))).move(null);
    expect(moved.parentId).toBe(null);

    const grant = await rootGrant(repository);
    const issued = await grant.tokens.create({ label: 'cli' });
    await issued.revoke();
    await grant.revoke();
    await (await repository.resources.get(resourceId('acme'))).delete();

    await expect(repository.resources.get(resourceId('acme'))).rejects.toThrow('Resource does not exist');
    expect((await repository.grants.get(grant.id)).revokedAt).not.toBe(null);
    expect((await repository.tokens.get(issued.id)).revokedAt).not.toBe(null);
  });

  it('does not revoke grants when resources move or are deleted', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    await grant.resources.set([
      { id: resourceId('drive'), permissions: ['read'] },
      { path: 'acme/drive', permissions: ['read'] },
    ]);

    await (await repository.resources.get(resourceId('drive'))).move(null);
    await (await repository.resources.get(resourceId('drive'))).delete();

    expect((await repository.grants.get(grant.id)).revokedAt).toBe(null);
  });

  it('runs guarded commands against the store', async () => {
    const store = open({ initialState: acme() });
    const repository = store.admin();
    const grant = await rootGrant(repository);
    await grant.resources.set([
      { id: resourceId('acme'), permissions: ['write'] },
    ]);
    const { value } = await grant.tokens.create({ label: 'cli' });
    const guarded = store.as(value);

    const created = await guarded.resources.create({ name: 'acme/platform/docs/design' });
    expect(created.name).toBe('design');
    expect(created.parentId).not.toBeNull();
    const handleChild = await (await guarded.resources.get(resourceId('acme'))).create({ name: 'mcp' });
    expect(handleChild.parentId).toBe('acme');
    const child = await guarded.grants.create({
      name: 'Acme admin/Drive write', resources: [], expiresAt: null,
    });
    expect(child.parentId).toBe(grant.id);
    await child.resources.set([{ id: resourceId('acme'), permissions: ['write'] }]);
    await expect((await guarded.resources.get(resourceId('acme'))).delete()).rejects.toThrow();
  });

  it('writes a state larger than one insert statement', async () => {
    const initialState: State = {
      resources: {}, grants: {}, tokens: {}, executables: {},
      audit: [],
    };
    for (let index = 0; index < 250; index += 1) {
      const id = resourceId(`resource-${index}`);
      initialState.resources[id] = {
        id, parentId: index === 0 ? null : resourceId(`resource-${index - 1}`), name: `r${index}`,
        deletedAt: null,
      };
    }
    const repository = open({ initialState }).admin();
    const state = await queriedState(repository);
    expect(Object.keys(state.resources)).toHaveLength(250);
    expect(state.resources['resource-249'].parentId).toBe('resource-248');
  });

  it('refuses to write a state whose parents form a cycle', () => {
    const initialState: State = {
      resources: {
        a: { id: resourceId('a'), parentId: resourceId('b'), name: 'a', deletedAt: null },
        b: { id: resourceId('b'), parentId: resourceId('a'), name: 'b', deletedAt: null },
      },
      grants: {}, tokens: {}, executables: {},
      audit: [],
    };
    expect(() => open({ initialState })).toThrow(RgapError);
  });
});
