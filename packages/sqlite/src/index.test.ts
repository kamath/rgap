import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { guardCommands, RgapError, type State } from '@rgap/core';
import { SqliteRgapRepository } from './index';

const open = (options?: { url?: string; initialState?: State }) => {
  const repository = new SqliteRgapRepository(options);
  opened.push(repository);
  return repository;
};

const opened: SqliteRgapRepository[] = [];
const directories: string[] = [];

const file = () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgap-sqlite-'));
  directories.push(directory);
  return join(directory, 'rgap.db');
};

afterEach(() => {
  opened.splice(0).forEach((repository) => repository.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const acme = (): State => ({
  resources: {
    acme: { id: 'acme', parentId: null, name: 'acme', deletedAt: null },
    drive: { id: 'drive', parentId: 'acme', name: 'drive', deletedAt: null },
  },
  grants: {},
  tokens: {},
  audit: [],
});

const rootGrant = (repository: SqliteRgapRepository) =>
  repository.createGrant({ name: 'Acme admin', subject: 'alice', parentId: null, capabilities: [], expiresAt: null });

describe('SqliteRgapRepository', () => {
  it('round-trips a complete state through SQL', async () => {
    const repository = open({ initialState: acme() });
    const grant = await rootGrant(repository);
    await repository.setCapabilities(grant.id, [
      { target: { type: 'resource', resourceId: 'acme' }, permissions: ['read', 'write'], descendants: true },
      { target: { type: 'path', path: 'acme/future-tool' }, permissions: ['invoke'], descendants: false },
    ]);
    const { record } = await repository.issueToken(grant.id, 'cli');

    const state = await repository.readState();
    expect(state.resources.drive.parentId).toBe('acme');
    expect(state.grants[grant.id].capabilities).toEqual([
      { target: { type: 'resource', resourceId: 'acme' }, permissions: ['read', 'write'], descendants: true },
      { target: { type: 'path', path: 'acme/future-tool' }, permissions: ['invoke'], descendants: false },
    ]);
    expect(state.tokens[record.id]).toEqual(record);
  });

  it('reads a permission set in the protocol canonical order', async () => {
    const repository = open({ initialState: acme() });
    const grant = await rootGrant(repository);
    const amended = await repository.setCapabilities(grant.id, [
      { target: { type: 'resource', resourceId: 'acme' }, permissions: ['invoke', 'delete', 'read'], descendants: true },
    ]);
    expect(amended.capabilities[0].permissions).toEqual(['read', 'delete', 'invoke']);
  });

  it('stores path targets without a resource foreign key value', async () => {
    const url = file();
    const repository = open({ url, initialState: acme() });
    const grant = await rootGrant(repository);
    await repository.setCapabilities(grant.id, [
      { target: { type: 'path', path: 'acme/not-created-yet' }, permissions: ['write'], descendants: true },
    ]);
    repository.close();

    const connection = new Database(url, { readonly: true });
    const row = connection.prepare(
      'select target_type, resource_id, path from capabilities where grant_id = ?',
    ).get(grant.id);
    connection.close();

    expect(row).toEqual({
      target_type: 'path',
      resource_id: null,
      path: 'acme/not-created-yet',
    });
  });

  it('keeps a file database across repositories and seeds only an empty one', async () => {
    const url = file();
    const first = open({ url, initialState: acme() });
    const created = await first.createResource({
      name: 'mcp', parentId: 'acme',
    });
    first.close();

    // A database that already holds records is opened as it stands, so this initial state is not applied.
    const second = open({ url, initialState: { resources: {}, grants: {}, tokens: {}, audit: [] } });
    const state = await second.readState();
    expect(state.resources[created.id]).toEqual(created);
    expect(Object.keys(state.resources)).toContain('acme');
  });

  it('restores the initial state on reset', async () => {
    const repository = open({ initialState: acme() });
    await repository.createResource({ name: 'mcp', parentId: 'acme' });
    await repository.reset();
    expect(await repository.readState()).toEqual(acme());
  });

  it('opens an empty store with no initial state at all', async () => {
    const repository = open();
    expect(await repository.readState()).toEqual({ resources: {}, grants: {}, tokens: {}, audit: [] });
  });

  it('writes nothing when a command is refused', async () => {
    const repository = open({ initialState: acme() });
    const parent = await rootGrant(repository);
    await repository.setCapabilities(parent.id, [
      { target: { type: 'resource', resourceId: 'drive' }, permissions: ['read'], descendants: true },
    ]);
    const child = await repository.createGrant({
      name: 'Drive read', subject: 'bob', parentId: parent.id, capabilities: [], expiresAt: null,
    });
    const before = await repository.readState();

    await expect(
      repository.setCapabilities(child.id, [
        { target: { type: 'resource', resourceId: 'acme' }, permissions: ['write'], descendants: true },
      ]),
    ).rejects.toThrow(RgapError);

    expect(await repository.readState()).toEqual(before);
  });

  it('records an authorization decision in the audit log, newest first', async () => {
    const repository = open({ initialState: acme() });
    const grant = await rootGrant(repository);
    await repository.setCapabilities(grant.id, [
      { target: { type: 'resource', resourceId: 'acme' }, permissions: ['read'], descendants: true },
    ]);
    const { value } = await repository.issueToken(grant.id, 'cli');

    expect((await repository.authorize(value, 'drive', 'read')).allowed).toBe(true);
    expect((await repository.authorize(value, 'drive', 'write')).allowed).toBe(false);

    const { audit } = await repository.readState();
    expect(audit.slice(0, 2).map((event) => event.result)).toEqual(['denied', 'allowed']);
    expect(audit.every((event) => event.action.length > 0)).toBe(true);
  });

  it('reports the authority a token holds', async () => {
    const repository = open({ initialState: acme() });
    const grant = await rootGrant(repository);
    await repository.setCapabilities(grant.id, [
      { target: { type: 'resource', resourceId: 'drive' }, permissions: ['read', 'invoke'], descendants: false },
    ]);
    const { value } = await repository.issueToken(grant.id, 'cli');

    const authority = await repository.inspectToken(value);
    expect(authority.valid).toBe(true);
    expect(authority.permissions.drive).toEqual(['read', 'invoke']);
    expect((await repository.inspectToken('rgap_unknown')).valid).toBe(false);
  });

  it('moves, deletes, and revokes', async () => {
    const repository = open({ initialState: acme() });
    const moved = await repository.moveResource('drive', null);
    expect(moved.parentId).toBe(null);

    const grant = await rootGrant(repository);
    const { record } = await repository.issueToken(grant.id, 'cli');
    await repository.revokeToken(record.id);
    await repository.revokeGrant(grant.id);
    await repository.deleteResource('acme');

    const state = await repository.readState();
    expect(state.resources.acme.deletedAt).not.toBe(null);
    expect(state.grants[grant.id].revokedAt).not.toBe(null);
    expect(state.tokens[record.id].revokedAt).not.toBe(null);
  });

  it('does not revoke grants when resources move or are deleted', async () => {
    const repository = open({ initialState: acme() });
    const grant = await rootGrant(repository);
    await repository.setCapabilities(grant.id, [
      { target: { type: 'resource', resourceId: 'drive' }, permissions: ['read'], descendants: false },
      { target: { type: 'path', path: 'acme/drive' }, permissions: ['read'], descendants: false },
    ]);

    await repository.moveResource('drive', null);
    await repository.deleteResource('drive');

    expect((await repository.readState()).grants[grant.id].revokedAt).toBe(null);
  });

  it('runs guarded commands against the store', async () => {
    const repository = open({ initialState: acme() });
    const grant = await rootGrant(repository);
    await repository.setCapabilities(grant.id, [
      { target: { type: 'resource', resourceId: 'acme' }, permissions: ['write'], descendants: true },
    ]);
    const { value } = await repository.issueToken(grant.id, 'cli');
    const guarded = guardCommands(repository, value);

    const created = await guarded.createResource({
      name: 'mcp', parentId: 'acme',
    });
    expect(created.parentId).toBe('acme');
    await expect(guarded.deleteResource('acme')).rejects.toThrow();
  });

  it('writes a state larger than one insert statement', async () => {
    const initialState: State = { resources: {}, grants: {}, tokens: {}, audit: [] };
    for (let index = 0; index < 250; index += 1) {
      const id = `resource-${index}`;
      initialState.resources[id] = {
        id, parentId: index === 0 ? null : `resource-${index - 1}`, name: `r${index}`,
        deletedAt: null,
      };
    }
    const repository = open({ initialState });
    const state = await repository.readState();
    expect(Object.keys(state.resources)).toHaveLength(250);
    expect(state.resources['resource-249'].parentId).toBe('resource-248');
  });

  it('refuses to write a state whose parents form a cycle', () => {
    const initialState: State = {
      resources: {
        a: { id: 'a', parentId: 'b', name: 'a', deletedAt: null },
        b: { id: 'b', parentId: 'a', name: 'b', deletedAt: null },
      },
      grants: {}, tokens: {}, audit: [],
    };
    expect(() => open({ initialState })).toThrow(RgapError);
  });
});
