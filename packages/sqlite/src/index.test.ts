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
  type JsonSchemaValidator,
  type RgapRepository,
  type ResourceId,
  type RuntimeCredentialStore,
  type SecretStore,
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
  executableRevisions: {},
  secretMetadata: {},
  runtimePrivateMetadata: {},
  audit: [],
});

const tokenRecord = (token: { id: string; grantId: string; label: string; hash: string; expiresAt: string | null; revokedAt: string | null }) =>
  ({ id: token.id, grantId: token.grantId, label: token.label, hash: token.hash, expiresAt: token.expiresAt, revokedAt: token.revokedAt });

const resourceRecord = (resource: { id: string; parentId: string | null; name: string; deletedAt: string | null }) =>
  ({ id: resource.id, parentId: resource.parentId, name: resource.name, deletedAt: resource.deletedAt });

const rootGrant = (repository: RgapRepository) =>
  repository.grants.create({ name: 'Acme admin', capabilities: [], expiresAt: null });

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
    executableRevisions: {},
    secretMetadata: {},
    runtimePrivateMetadata: {},
    audit,
  };
}

const validator: JsonSchemaValidator = {
  validate: (schema) => schema === false
    ? { valid: false, errors: ['false schema'] }
    : { valid: true },
};

class FakeSecrets implements SecretStore {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  rejectWrites = false;

  async write(id: ResourceId, value: string) {
    if (this.rejectWrites) throw new Error('secret backend rejected write');
    this.values.set(id, value);
    return { resourceId: id, version: `v${this.values.size}`, updatedAt: '2026-08-22T08:00:00.000Z' };
  }

  async delete(id: ResourceId) {
    this.deleted.push(id);
    this.values.delete(id);
  }

  async handle(id: ResourceId) {
    return { kind: 'secret' as const, resourceId: id };
  }
}

class FakeCredentials implements RuntimeCredentialStore {
  readonly values = new Map<string, unknown>();
  readonly deleted: string[] = [];
  rejectWrites = false;
  private key(runtime: string, id: ResourceId) {
    return `${runtime}\u0000${id}`;
  }

  async metadata(runtime: string, id: ResourceId) {
    return this.values.has(this.key(runtime, id))
      ? { runtime, resourceId: id, version: 'credential-v1', updatedAt: '2026-08-22T08:00:00.000Z' }
      : undefined;
  }

  async handle(runtime: string, id: ResourceId) {
    return this.values.has(this.key(runtime, id))
      ? { kind: 'runtime-credential' as const, runtime, resourceId: id }
      : undefined;
  }

  async write(runtime: string, id: ResourceId, value: unknown) {
    if (this.rejectWrites) throw new Error('credential backend rejected write');
    this.values.set(this.key(runtime, id), value);
    return {
      runtime, resourceId: id, version: 'credential-v1', updatedAt: '2026-08-22T08:00:00.000Z',
    };
  }

  async delete(runtime: string, id: ResourceId) {
    const key = this.key(runtime, id);
    this.deleted.push(key);
    this.values.delete(key);
  }
}

const publication = (bindingSchema: Record<string, {
  kind: 'resource' | 'secret' | 'runtime-private';
  access: 'use' | 'write';
  required?: boolean;
}> = {}) => ({
  runtime: 'test',
  program: { operation: 'echo' },
  inputSchema: true,
  outputSchema: true,
  bindingSchema,
  limits: { timeoutMs: 50 },
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
    await grant.capabilities.set([
      { resourceId: resourceId('acme'), permissions: ['read', 'write'] },
      { path: 'acme/future-tool', permissions: ['invoke'] },
    ]);
    const issued = await grant.tokens.create({ label: 'cli' });

    const state = await queriedState(repository);
    expect(state.resources.drive.parentId).toBe('acme');
    expect(state.grants[grant.id].capabilities).toEqual([
      { resourceId: resourceId('acme'), permissions: ['read', 'write'] },
      { path: 'acme/future-tool', permissions: ['invoke'] },
    ]);
    expect(state.tokens[issued.id]).toEqual(tokenRecord(issued));
  });

  it('persists executable definitions and immutable revisions across restart', async () => {
    const url = file();
    const runtime: InvokeRuntime = { validate: vi.fn(), async *invoke() { yield { type: 'done' }; } };
    const options = {
      url,
      initialState: acme(),
      runtimes: new RuntimeRegistry({ test: runtime }),
      validator,
    };
    const firstStore = open(options);
    const first = firstStore.admin();
    const drive = await first.resources.get(resourceId('drive'));
    const revisionOne = await drive.executable.publish(publication());
    const revisionTwo = await drive.executable.publish({
      ...publication(), program: { operation: 'echo-again' },
    });
    expect((await drive.executable.get())?.activeRevisionId).toBe(revisionTwo.id);
    expect((await drive.executable.revisions()).map(({ id }) => id).sort())
      .toEqual([revisionOne.id, revisionTwo.id].sort());
    firstStore.close();

    const second = open({ ...options, initialState: undefined }).admin();
    expect(await second.executables.getRevision(revisionOne.id)).toEqual(revisionOne);
    expect((await second.executables.get(resourceId('drive')))?.activeRevisionId).toBe(revisionTwo.id);
    await second.executables.delete(resourceId('drive'));
    expect((await second.executables.get(resourceId('drive')))?.deletedAt).not.toBeNull();
    expect(await second.executables.revisions(resourceId('drive'))).toHaveLength(2);
  });

  it('fails clearly when executable publication names an unknown runtime', async () => {
    const repository = open({ initialState: acme() }).admin();
    await expect(repository.executables.publish(resourceId('drive'), publication()))
      .rejects.toMatchObject({ code: 'unknown_runtime' });
  });

  it('keeps secret plaintext in the injected store and preserves metadata after a rejected write', async () => {
    const url = file();
    const secrets = new FakeSecrets();
    const repository = open({ url, initialState: acme(), secrets }).admin();
    const plaintext = 'plaintext-must-not-enter-sqlite';
    const metadata = await repository.secrets.write(resourceId('drive'), plaintext);
    expect(secrets.values.get('drive')).toBe(plaintext);
    expect(await repository.secrets.metadata(resourceId('drive'))).toEqual(metadata);

    secrets.rejectWrites = true;
    await expect(repository.secrets.write(resourceId('drive'), 'rejected-plaintext'))
      .rejects.toThrow('backend rejected');
    expect(await repository.secrets.metadata(resourceId('drive'))).toEqual(metadata);

    const connection = new Database(url, { readonly: true });
    const persisted = JSON.stringify({
      metadata: connection.prepare('select * from secret_metadata').all(),
      audit: connection.prepare('select * from audit').all(),
    });
    connection.close();
    expect(persisted).not.toContain(plaintext);
    expect(persisted).not.toContain('rejected-plaintext');
  });

  it('synchronizes runtime-owned credential metadata and records audit-safe invoke facts', async () => {
    const url = file();
    const credentials = new FakeCredentials();
    const inputMarker = 'private-invocation-input';
    const outputMarker = 'private-runtime-output';
    let eraseCredential = false;
    const runtime: InvokeRuntime = {
      validate() {},
      async *invoke(context) {
        expect(context.limits.timeoutMs).toBe(50);
        if (eraseCredential) await context.credentials.delete('connection');
        else await context.credentials.write('connection', { refreshToken: 'private-credential-value' });
        yield { type: 'data', value: outputMarker };
        yield { type: 'done' };
      },
    };
    const options: SqliteRgapStoreOptions = {
      url,
      initialState: acme(),
      runtimes: { test: runtime },
      validator,
      runtimeLimits: { test: { timeoutMs: 100 } },
      credentials,
    };
    const firstStore = open(options);
    const first = firstStore.admin();
    await first.executables.publish(resourceId('drive'), publication({
      connection: { kind: 'runtime-private', access: 'write' },
    }));
    expect(await collect(first.invoke(resourceId('drive'), {
      input: inputMarker,
      bindings: { connection: resourceId('acme') },
    }))).toEqual([{ type: 'data', value: outputMarker }, { type: 'done' }]);
    expect(await first.runtimePrivateMetadata('test', resourceId('acme'))).toEqual({
      runtime: 'test',
      resourceId: resourceId('acme'),
      version: 'credential-v1',
      updatedAt: '2026-08-22T08:00:00.000Z',
    });
    const invokeAudit = (await first.audit.list()).find(({ action }) => action === 'executable.invoke')!;
    expect(invokeAudit.detail).toContain('"runtime":"test"');
    expect(invokeAudit.detail).toContain('"result":"done"');
    expect(invokeAudit.detail).not.toContain(inputMarker);
    expect(invokeAudit.detail).not.toContain(outputMarker);
    expect(invokeAudit.detail).not.toContain('private-credential-value');
    firstStore.close();

    const restarted = open({ ...options, initialState: undefined }).admin();
    expect((await restarted.runtimePrivateMetadata('test', resourceId('acme')))?.version)
      .toBe('credential-v1');
    credentials.rejectWrites = true;
    await expect(collect(restarted.invoke(resourceId('drive'), {
      input: {}, bindings: { connection: resourceId('acme') },
    }))).rejects.toThrow('credential backend rejected');
    expect((await restarted.runtimePrivateMetadata('test', resourceId('acme')))?.version)
      .toBe('credential-v1');
    credentials.rejectWrites = false;
    eraseCredential = true;
    await collect(restarted.invoke(resourceId('drive'), {
      input: {}, bindings: { connection: resourceId('acme') },
    }));
    expect(await restarted.runtimePrivateMetadata('test', resourceId('acme'))).toBeUndefined();
    expect(credentials.deleted).toContain('test\u0000acme');
  });

  it('authorizes invocation through the guarded plane while admin remains unrestricted', async () => {
    const runtime: InvokeRuntime = { validate() {}, async *invoke() { yield { type: 'done' }; } };
    const store = open({ initialState: acme(), runtimes: { test: runtime }, validator });
    const admin = store.admin();
    await admin.executables.publish(resourceId('drive'), publication());
    expect(await collect(admin.invoke(resourceId('drive'), { input: {} }))).toEqual([{ type: 'done' }]);

    const grant = await rootGrant(admin);
    await grant.capabilities.set([{ resourceId: resourceId('drive'), permissions: ['read'] }]);
    const { value } = await grant.tokens.create({ label: 'reader' });
    await expect(collect(store.as(value).invoke(resourceId('drive'), { input: {} })))
      .rejects.toMatchObject({ code: 'unauthorized' });

    const invoker = await rootGrant(admin);
    await invoker.capabilities.set([{ resourceId: resourceId('drive'), permissions: ['invoke'] }]);
    const allowed = await invoker.tokens.create({ label: 'invoker' });
    expect(await collect(store.as(allowed.value).invoke(resourceId('drive'), { input: {} })))
      .toEqual([{ type: 'done' }]);
  });

  it('reset clears tracked metadata through injected stores and cannot discover untracked values', async () => {
    const secrets = new FakeSecrets();
    const credentials = new FakeCredentials();
    const runtime: InvokeRuntime = {
      validate() {},
      async *invoke(context) {
        await context.credentials.write('connection', { protected: true });
        yield { type: 'done' };
      },
    };
    const repository = open({
      initialState: acme(), secrets, credentials, runtimes: { test: runtime }, validator,
    }).admin();
    await repository.secrets.write(resourceId('drive'), 'tracked-secret');
    secrets.values.set('external-untracked', 'preserved');
    credentials.values.set('test\u0000external-untracked', { preserved: true });
    await repository.executables.publish(resourceId('drive'), publication({
      connection: { kind: 'runtime-private', access: 'write' },
    }));
    await collect(repository.invoke(resourceId('drive'), {
      input: {}, bindings: { connection: resourceId('acme') },
    }));

    await repository.reset();
    expect(await queriedState(repository)).toEqual(acme());
    expect(secrets.deleted).toContain('drive');
    expect(credentials.deleted).toContain('test\u0000acme');
    // The interfaces expose no bulk discovery API, so values absent from SQLite metadata are preserved.
    expect(secrets.values.get('external-untracked')).toBe('preserved');
    expect(credentials.values.get('test\u0000external-untracked')).toEqual({ preserved: true });
  });

  it('reads a permission set in the protocol canonical order', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    const amended = await grant.capabilities.set([
      { resourceId: resourceId('acme'), permissions: ['invoke', 'delete', 'read'] },
    ]);
    expect(amended.capabilities[0].permissions).toEqual(['read', 'invoke', 'delete']);
  });

  it('stores path targets without a resource foreign key value', async () => {
    const url = file();
    const store = open({ url, initialState: acme() });
    const repository = store.admin();
    const grant = await rootGrant(repository);
    await grant.capabilities.set([
      { path: 'acme/not-created-yet', permissions: ['write'] },
    ]);
    store.close();

    const connection = new Database(url, { readonly: true });
    const row = connection.prepare(
      'select resource_id, path from capabilities where grant_id = ?',
    ).get(grant.id);
    connection.close();

    expect(row).toEqual({
      resource_id: null,
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
        resources: {}, grants: {}, tokens: {}, executables: {}, executableRevisions: {},
        secretMetadata: {}, runtimePrivateMetadata: {}, audit: [],
      },
    }).admin();
    const state = await queriedState(second);
    expect(state.resources[created.id]).toEqual(resourceRecord(created));
    expect(Object.keys(state.resources)).toContain('acme');
  });

  it('restores the initial state on reset', async () => {
    const repository = open({ initialState: acme() }).admin();
    await (await repository.resources.get(resourceId('acme'))).create({ name: 'mcp' });
    await repository.reset();
    expect(await queriedState(repository)).toEqual(acme());
  });

  it('opens an empty store with no initial state at all', async () => {
    const repository = open().admin();
    expect(await queriedState(repository)).toEqual({
      resources: {}, grants: {}, tokens: {}, executables: {}, executableRevisions: {},
      secretMetadata: {}, runtimePrivateMetadata: {}, audit: [],
    });
  });

  it('writes nothing when a command is refused', async () => {
    const repository = open({ initialState: acme() }).admin();
    const parent = await rootGrant(repository);
    await parent.capabilities.set([
      { resourceId: resourceId('drive'), permissions: ['read'] },
    ]);
    const child = await parent.create({
      name: 'Drive read', capabilities: [], expiresAt: null,
    });
    const before = await queriedState(repository);

    await expect(
      child.capabilities.set([
        { resourceId: resourceId('acme'), permissions: ['write'] },
      ]),
    ).rejects.toThrow(RgapError);

    expect(await queriedState(repository)).toEqual(before);
  });

  it('records an authorization decision in the audit log, newest first', async () => {
    const repository = open({ initialState: acme() }).admin();
    const grant = await rootGrant(repository);
    await grant.capabilities.set([
      { resourceId: resourceId('acme'), permissions: ['read'] },
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
    await grant.capabilities.set([
      { resourceId: resourceId('drive'), permissions: ['read', 'invoke'] },
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
    await grant.capabilities.set([
      { resourceId: resourceId('drive'), permissions: ['read'] },
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
    await grant.capabilities.set([
      { resourceId: resourceId('acme'), permissions: ['write'] },
    ]);
    const { value } = await grant.tokens.create({ label: 'cli' });
    const guarded = store.as(value);

    const created = await (await guarded.resources.get(resourceId('acme'))).create({ name: 'mcp' });
    expect(created.parentId).toBe('acme');
    const child = await guarded.grants.create({ name: 'Drive write', capabilities: [], expiresAt: null });
    expect(child.parentId).toBe(grant.id);
    await child.capabilities.set([{ resourceId: resourceId('acme'), permissions: ['write'] }]);
    await expect((await guarded.resources.get(resourceId('acme'))).delete()).rejects.toThrow();
  });

  it('writes a state larger than one insert statement', async () => {
    const initialState: State = {
      resources: {}, grants: {}, tokens: {}, executables: {}, executableRevisions: {},
      secretMetadata: {}, runtimePrivateMetadata: {}, audit: [],
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
      grants: {}, tokens: {}, executables: {}, executableRevisions: {},
      secretMetadata: {}, runtimePrivateMetadata: {}, audit: [],
    };
    expect(() => open({ initialState })).toThrow(RgapError);
  });
});
