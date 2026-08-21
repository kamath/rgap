import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { asc } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  authorize as decide,
  availableId,
  createGrant as addGrant,
  createResource as addResource,
  deleteResource as removeResource,
  inspectAuthority,
  moveResource as move,
  permissions as canonicalPermissions,
  recordToken,
  revokeGrant as revokeGrantBranch,
  revokeToken as revokeTokenRecord,
  setCapabilities as amendCapabilities,
  RgapError,
  type Capability,
  type CreateGrantInput,
  type CreateResourceInput,
  type Permission,
  type RgapRepository,
  type State,
  type Token,
} from '@rgap/core';
import * as schema from './schema';

export * as schema from './schema';

export type SqliteRgapRepositoryOptions = {
  /** A file path, or `:memory:` for a database that lives as long as the repository. */
  url?: string;
  /** What an empty database is initialized with, and what `reset` restores. */
  initialState?: State;
};

export class SqliteRgapRepository implements RgapRepository {
  private connection: Database.Database;
  private db: BetterSQLite3Database;
  private initialState: State;

  constructor(options: SqliteRgapRepositoryOptions = {}) {
    this.initialState = structuredClone(options.initialState ?? emptyState());
    this.connection = new Database(options.url ?? ':memory:');
    this.connection.pragma('foreign_keys = ON');
    this.db = drizzle(this.connection);
    migrate(this.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    // A database that already holds records is opened as it stands; an empty one takes the initial state.
    this.db.transaction(() => {
      if (this.isEmpty()) this.replace(this.initialState);
    });
  }

  async readState(): Promise<State> {
    return this.read();
  }

  async createResource(input: CreateResourceInput) {
    return this.commit((state) => {
      const id = availableId(state, input.name);
      return { state: addResource(state, input, id, now()), pick: (committed) => committed.resources[id] };
    });
  }

  async moveResource(id: string, parentId: string | null) {
    return this.commit((state) => ({
      state: move(state, id, parentId, now()),
      pick: (committed) => committed.resources[id],
    }));
  }

  async deleteResource(id: string) {
    this.commit((state) => ({ state: removeResource(state, id, now()), pick: () => undefined }));
  }

  async createGrant(input: CreateGrantInput) {
    const id = randomUUID();
    return this.commit((state) => ({
      state: addGrant(state, input, id, now()),
      pick: (committed) => committed.grants[id],
    }));
  }

  async setCapabilities(grantId: string, capabilities: Capability[]) {
    return this.commit((state) => ({
      state: amendCapabilities(state, grantId, capabilities, now()),
      pick: (committed) => committed.grants[grantId],
    }));
  }

  async issueToken(grantId: string, label: string) {
    const value = `rgap_${randomUUID().replaceAll('-', '')}`;
    const id = randomUUID();
    const record = this.commit((state) => {
      const token: Token = {
        id,
        grantId,
        label: label.trim() || 'unnamed token',
        hash: hash(value),
        expiresAt: state.grants[grantId]?.expiresAt ?? null,
        revokedAt: null,
      };
      return { state: recordToken(state, token, now()), pick: (committed) => committed.tokens[id] };
    });
    return { record, value };
  }

  async revokeToken(id: string) {
    this.commit((state) => ({ state: revokeTokenRecord(state, id, now()), pick: () => undefined }));
  }

  async revokeGrant(id: string) {
    this.commit((state) => ({ state: revokeGrantBranch(state, id, now()), pick: () => undefined }));
  }

  async authorize(token: string, resourceId: string, permission: Permission) {
    const at = now();
    return this.commit((state) => {
      const decision = decide(state, hash(token), resourceId, permission, at);
      const next = structuredClone(state);
      next.audit.unshift({
        id: randomUUID(),
        at,
        action: 'authorize',
        target: resourceId,
        result: decision.allowed ? 'allowed' : 'denied',
        detail: decision.detail,
      });
      return { state: next, pick: () => decision };
    });
  }

  async inspectToken(token: string) {
    return inspectAuthority(this.read(), hash(token), now());
  }

  async reset() {
    this.commit(() => ({ state: structuredClone(this.initialState), pick: () => undefined }));
  }

  /** Releases the connection. A `:memory:` database ceases to exist with it. */
  close() {
    this.connection.close();
  }

  /**
   * One command, one transaction: read the whole state, apply the pure rule, store what it returns.
   * The record a command returns is read back out of the store, so it is exactly what was written.
   */
  private commit<T>(apply: (state: State) => { state: State; pick: (committed: State) => T }): T {
    return this.db.transaction(() => {
      const { state, pick } = apply(this.read());
      this.replace(state);
      return pick(this.read());
    });
  }

  private read(): State {
    const state = emptyState();

    this.db.select().from(schema.resources).orderBy(asc(schema.resources.id)).all().forEach((row) => {
      state.resources[row.id] = {
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        deletedAt: row.deletedAt,
      };
    });

    this.db.select().from(schema.grants).orderBy(asc(schema.grants.id)).all().forEach((row) => {
      state.grants[row.id] = {
        id: row.id,
        name: row.name,
        subject: row.subject,
        parentId: row.parentId,
        capabilities: [],
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      };
    });

    const held = new Map<string, Set<Permission>>();
    this.db.select().from(schema.capabilityPermissions).all().forEach((row) => {
      const key = entryKey(row.grantId, row.position);
      const set = held.get(key) ?? new Set<Permission>();
      set.add(row.permission);
      held.set(key, set);
    });

    this.db
      .select()
      .from(schema.capabilities)
      .orderBy(asc(schema.capabilities.grantId), asc(schema.capabilities.position))
      .all()
      .forEach((row) => {
        const carried = held.get(entryKey(row.grantId, row.position));
        const target: Capability['target'] = row.targetType === 'resource'
          ? { type: 'resource', resourceId: row.resourceId! }
          : { type: 'path', path: row.path! };
        state.grants[row.grantId].capabilities.push({
          target,
          // An entry's permissions are a set, so they are read in the protocol's canonical order.
          permissions: canonicalPermissions.filter((permission) => carried?.has(permission)),
          descendants: row.descendants,
        });
      });

    this.db.select().from(schema.tokens).orderBy(asc(schema.tokens.id)).all().forEach((row) => {
      state.tokens[row.id] = {
        id: row.id,
        grantId: row.grantId,
        label: row.label,
        hash: row.hash,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      };
    });

    this.db.select().from(schema.audit).orderBy(asc(schema.audit.seq)).all().forEach((row) => {
      state.audit.push({
        id: row.id,
        at: row.at,
        action: row.action,
        target: row.target,
        result: row.result,
        detail: row.detail,
      });
    });

    return state;
  }

  /** Replaces the stored rows with one complete state, writing parents before children. */
  private replace(state: State) {
    this.db.delete(schema.capabilityPermissions).run();
    this.db.delete(schema.capabilities).run();
    this.db.delete(schema.tokens).run();
    this.db.delete(schema.audit).run();
    this.db.delete(schema.grants).run();
    this.db.delete(schema.resources).run();

    insert(this.db, schema.resources, parentsFirst(state.resources, 'resource_cycle'));
    insert(this.db, schema.grants, parentsFirst(state.grants, 'grant_cycle').map((grant) => ({
      id: grant.id,
      name: grant.name,
      subject: grant.subject,
      parentId: grant.parentId,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    })));

    const entries: (typeof schema.capabilities)['$inferInsert'][] = [];
    const carried: (typeof schema.capabilityPermissions)['$inferInsert'][] = [];
    Object.values(state.grants).forEach((grant) => {
      grant.capabilities.forEach((capability, position) => {
        entries.push({
          grantId: grant.id,
          position,
          targetType: capability.target.type,
          resourceId: capability.target.type === 'resource' ? capability.target.resourceId : null,
          path: capability.target.type === 'path' ? capability.target.path : null,
          descendants: capability.descendants,
        });
        capability.permissions.forEach((permission) => {
          carried.push({ grantId: grant.id, position, permission });
        });
      });
    });
    insert(this.db, schema.capabilities, entries);
    insert(this.db, schema.capabilityPermissions, carried);

    insert(this.db, schema.tokens, Object.values(state.tokens));
    insert(this.db, schema.audit, state.audit.map((event, seq) => ({ ...event, seq })));
  }

  private isEmpty() {
    return [schema.resources, schema.grants, schema.tokens, schema.audit].every(
      (table) => this.db.select().from(table).limit(1).all().length === 0,
    );
  }
}

const emptyState = (): State => ({ resources: {}, grants: {}, tokens: {}, audit: [] });
const now = () => new Date().toISOString();
const entryKey = (grantId: string, position: number) => `${grantId}:${position}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Records ordered so that every parent precedes its children, which is what lets the foreign keys
 * hold statement by statement. A cycle has no such order, so it is reported rather than written.
 */
function parentsFirst<T extends { id: string; parentId: string | null }>(records: Record<string, T>, code: string) {
  const depth = (record: T) => {
    const seen = new Set<string>([record.id]);
    let steps = 0;
    for (let current = record.parentId; current; current = records[current]?.parentId ?? null) {
      if (seen.has(current)) throw new RgapError(code, 'State contains a cycle.');
      seen.add(current);
      steps += 1;
    }
    return steps;
  };
  return Object.values(records)
    .map((record) => ({ record, depth: depth(record) }))
    .sort((a, b) => a.depth - b.depth)
    .map((entry) => entry.record);
}

/** Inserts in batches, because one statement binds a bounded number of values. */
function insert<T extends SQLiteTable>(db: BetterSQLite3Database, table: T, rows: T['$inferInsert'][]) {
  for (let index = 0; index < rows.length; index += 100) {
    db.insert(table).values(rows.slice(index, index + 100)).run();
  }
}
