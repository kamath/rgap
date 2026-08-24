import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  authorize as decide,
  createAtPath,
  createGrantAtPath,
  deleteExecutable as removeExecutable,
  deleteResource as removeResource,
  grantId,
  grantIdAtPath,
  getAuthorizedLineage,
  guardCommands,
  invokeExecutable,
  moveResource as move,
  pageLimit,
  pathParts,
  permissions as canonicalPermissions,
  setExecutable as associateExecutable,
  recordToken,
  resourceId,
  resourceIdAtPath,
  resolveBearer as resolve,
  revokeGrant as revokeGrantBranch,
  revokeToken as revokeTokenRecord,
  RuntimeRegistry,
  setResources as amendResources,
  tokenHash,
  tokenId,
  tokenValue,
  repositoryFrom,
  RgapError,
  type GrantResource,
  type AuditEvent,
  type CreateGrantInput,
  type CreateResourceInput,
  type GrantId,
  type InvocationRecord,
  type InvokeInput,
  type RuntimeRegistrations,
  type Permission,
  type SetExecutableInput,
  type AuditListQuery,
  type RecordId,
  type ResourceId,
  type ResourceListQuery,
  type RgapCommands,
  type RgapRepository,
  type RgapStore,
  type State,
  type Token,
  type TokenId,
  type TokenListQuery,
  type TokenValue,
  type GrantListQuery,
} from '@rgap/core';
import * as schema from './schema';

export * as schema from './schema';

export type SqliteRgapStoreOptions = {
  /** A file path, or `:memory:` for a database that lives as long as the repository. */
  url?: string;
  /** What an empty database is initialized with, and what `reset` restores. */
  initialState?: State;
  /** Deployment-owned runtime implementations. They are configuration, not repository state. */
  runtimes?: RuntimeRegistry | RuntimeRegistrations;
};

export class SqliteRgapStore implements RgapStore {
  private readonly repository: SqliteBackingRepository;

  constructor(options: SqliteRgapStoreOptions = {}) {
    this.repository = new SqliteBackingRepository(options);
  }

  admin(): RgapRepository {
    return repositoryFrom(this.repository);
  }

  as(token: TokenValue): RgapRepository {
    return guardCommands(
      repositoryFrom(this.repository),
      token,
      (bearer) => this.repository.resolveBearer(bearer),
    );
  }

  /** Releases the connection. A `:memory:` database ceases to exist with it. */
  close() {
    this.repository.close();
  }
}

class SqliteBackingRepository implements RgapCommands {
  private connection: Database.Database;
  private db: BetterSQLite3Database;
  private initialState: State;
  private readonly runtimes: RuntimeRegistry;

  constructor(options: SqliteRgapStoreOptions = {}) {
    this.initialState = completeState(options.initialState);
    this.runtimes = options.runtimes instanceof RuntimeRegistry
      ? options.runtimes
      : new RuntimeRegistry(options.runtimes);
    this.connection = new Database(options.url ?? ':memory:');
    this.connection.pragma('foreign_keys = ON');
    this.db = drizzle(this.connection);
    migrate(this.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    // A database that already holds records is opened as it stands; an empty one takes the initial state.
    this.db.transaction(() => {
      if (this.isEmpty()) this.replace(this.initialState);
    });
  }

  async getResource(id: ResourceId) {
    const row = this.db.select().from(schema.resources).where(eq(schema.resources.id, id)).get();
    return row ? resourceRecord(row) : undefined;
  }

  async listResources(query: ResourceListQuery = {}) {
    const limit = pageLimit(query.limit);
    const parent = query.parentId === undefined
      ? undefined
      : query.parentId === null ? isNull(schema.resources.parentId) : eq(schema.resources.parentId, query.parentId);
    const rows = this.db.select().from(schema.resources)
      .where(and(parent, isNull(schema.resources.deletedAt), query.cursor ? gt(schema.resources.id, query.cursor) : undefined))
      .orderBy(asc(schema.resources.id)).limit(limit).all();
    return rows.map(resourceRecord);
  }

  async getGrant(id: GrantId) {
    const row = this.db.select().from(schema.grants).where(eq(schema.grants.id, id)).get();
    return row ? this.grantRecord(row) : undefined;
  }

  async listGrants(query: GrantListQuery = {}) {
    const limit = pageLimit(query.limit);
    const parent = query.parentId === undefined
      ? undefined
      : query.parentId === null ? isNull(schema.grants.parentId) : eq(schema.grants.parentId, query.parentId);
    const rows = this.db.select().from(schema.grants)
      .where(and(parent, query.cursor ? gt(schema.grants.id, query.cursor) : undefined))
      .orderBy(asc(schema.grants.id)).limit(limit).all();
    return rows.map((row) => this.grantRecord(row));
  }

  async getToken(id: TokenId) {
    const row = this.db.select().from(schema.tokens).where(eq(schema.tokens.id, id)).get();
    return row ? tokenRecord(row) : undefined;
  }

  async listTokens(query: TokenListQuery = {}) {
    const limit = pageLimit(query.limit);
    const rows = this.db.select().from(schema.tokens)
      .where(and(
        query.grantId === undefined ? undefined : eq(schema.tokens.grantId, query.grantId),
        query.cursor ? gt(schema.tokens.id, query.cursor) : undefined,
      ))
      .orderBy(asc(schema.tokens.id)).limit(limit).all();
    return rows.map(tokenRecord);
  }

  async listAudit(query: AuditListQuery = {}) {
    const limit = pageLimit(query.limit);
    let after: number | undefined;
    if (query.cursor) {
      const cursor = this.db.select({ seq: schema.audit.seq }).from(schema.audit)
        .where(eq(schema.audit.id, query.cursor)).get();
      if (!cursor) throw new RgapError('invalid_cursor', 'The collection cursor is unknown.');
      after = cursor.seq;
    }
    const rows = this.db.select().from(schema.audit)
      .where(after === undefined ? undefined : gt(schema.audit.seq, after))
      .orderBy(asc(schema.audit.seq)).limit(limit).all();
    return rows.map(auditRecord);
  }

  async createResource(input: CreateResourceInput) {
    return this.db.transaction(() => {
      const state = this.workingState();
      this.prepareResourcePath(state, input.name, input.parentId);
      const before = new Set(Object.keys(state.resources));
      const next = createAtPath(state, input.name, input.parentId, now());
      const id = resourceIdAtPath(next.resources, input.name, input.parentId);
      if (!id) throw new RgapError('invalid_name', 'Resource name is required.');
      const created = Object.values(next.resources).filter((resource) => !before.has(resource.id));
      insert(this.db, schema.resources, parentsFirst(
        Object.fromEntries(created.map((resource) => [resource.id, resource])),
        'resource_cycle',
      ));
      this.persistAuditDelta(state, next);
      return resourceRecord(this.db.select().from(schema.resources).where(eq(schema.resources.id, id)).get()!);
    });
  }

  async moveResource(id: ResourceId, parentId: ResourceId | null) {
    return this.db.transaction(() => {
      const state = this.workingState();
      this.loadResource(state, id);
      if (parentId) this.loadResourceAncestry(state, parentId);
      const next = move(state, id, parentId, now());
      this.db.update(schema.resources).set({ parentId }).where(eq(schema.resources.id, id)).run();
      this.persistAuditDelta(state, next);
      return resourceRecord(this.db.select().from(schema.resources).where(eq(schema.resources.id, id)).get()!);
    });
  }

  async deleteResource(id: ResourceId) {
    this.db.transaction(() => {
      const state = this.workingState();
      this.loadResourceBranch(state, id);
      const next = removeResource(state, id, now());
      Object.values(next.resources).forEach((resource) => {
        if (resource.deletedAt !== state.resources[resource.id]?.deletedAt) {
          this.db.update(schema.resources)
            .set({ deletedAt: resource.deletedAt })
            .where(eq(schema.resources.id, resource.id)).run();
        }
      });
      this.persistAuditDelta(state, next);
    });
  }

  async getExecutable(id: ResourceId) {
    const row = this.db.select().from(schema.executables).where(eq(schema.executables.resourceId, id)).get();
    return row ? {
      resourceId: resourceId(row.resourceId),
      runtime: row.runtime,
    } : undefined;
  }

  async setExecutable(id: ResourceId, input: SetExecutableInput) {
    return this.db.transaction(() => {
      const state = this.workingState();
      this.loadResource(state, id);
      const next = associateExecutable(state, id, input, now(), this.runtimes);
      const definition = next.executables[id];
      this.db.insert(schema.executables).values(definition)
        .onConflictDoUpdate({
          target: schema.executables.resourceId,
          set: { runtime: definition.runtime },
        }).run();
      this.persistAuditDelta(state, next);
      return {
        resourceId: id,
        runtime: this.db.select().from(schema.executables)
          .where(eq(schema.executables.resourceId, id)).get()!.runtime,
      };
    });
  }

  async deleteExecutable(id: ResourceId) {
    this.db.transaction(() => {
      const state = this.workingState();
      const row = this.db.select().from(schema.executables)
        .where(eq(schema.executables.resourceId, id)).get();
      if (row) state.executables[id] = { resourceId: id, runtime: row.runtime };
      const next = removeExecutable(state, id, now());
      this.db.delete(schema.executables).where(eq(schema.executables.resourceId, id)).run();
      this.persistAuditDelta(state, next);
    });
  }

  invoke(id: ResourceId, input: InvokeInput) {
    const repository = this;
    return (async function* () {
      yield* invokeExecutable({
        getDefinition: (resource) => repository.getExecutable(resource),
        // The selected repository plane already authorized invocation. The admin plane is unrestricted.
        authorize: async (resource) => {
          repository.requireLiveResource(resource);
          return { lineage: getAuthorizedLineage(input) };
        },
        runtimes: repository.runtimes,
        recordInvocation: (record) => repository.recordInvocation(record),
      }, id, input);
    })();
  }

  async createGrant(input: CreateGrantInput) {
    return this.db.transaction(() => {
      const at = now();
      const state = this.workingState();
      this.prepareGrantPath(state, input.name, input.parentId, at);
      this.loadGrantResourceTargets(state, [
        ...input.resources,
        ...Object.values(state.grants).flatMap((grant) => grant.resources),
      ]);
      const before = new Set(Object.keys(state.grants));
      const { parentId, ...write } = input;
      const next = createGrantAtPath(state, write, parentId, at);
      const id = grantIdAtPath(next.grants, input.name, parentId, at);
      if (!id) throw new RgapError('invalid_grant', 'Grant name is required.');
      const created = Object.values(next.grants).filter((grant) => !before.has(grant.id));
      insert(this.db, schema.grants, parentsFirst(
        Object.fromEntries(created.map((grant) => [grant.id, grant])),
        'grant_cycle',
      ).map(grantRow));
      created.forEach((grant) => this.replaceGrantResources(grant));
      this.persistAuditDelta(state, next);
      return this.grantRecord(this.db.select().from(schema.grants).where(eq(schema.grants.id, id)).get()!);
    });
  }

  async setResources(id: GrantId, resources: GrantResource[]) {
    return this.db.transaction(() => {
      const state = this.workingState();
      const grant = this.loadGrant(state, id);
      if (grant?.parentId) this.loadGrant(state, grant.parentId);
      this.loadGrantBranch(state, id);
      const directChildren = Object.values(state.grants)
        .filter((candidate) => candidate.parentId === id);
      this.loadGrantResourceTargets(state, [
        ...resources,
        ...(grant?.parentId ? state.grants[grant.parentId]?.resources ?? [] : []),
        ...directChildren.flatMap((child) => child.resources),
      ]);
      const next = amendResources(state, id, resources, now());
      this.replaceGrantResources(next.grants[id]);
      Object.values(next.grants).forEach((candidate) => {
        if (candidate.revokedAt !== state.grants[candidate.id]?.revokedAt) {
          this.db.update(schema.grants).set({ revokedAt: candidate.revokedAt })
            .where(eq(schema.grants.id, candidate.id)).run();
        }
      });
      this.persistAuditDelta(state, next);
      return this.grantRecord(this.db.select().from(schema.grants).where(eq(schema.grants.id, id)).get()!);
    });
  }

  async issueToken(id: GrantId, label: string) {
    const value = tokenValue(`rgap_${randomUUID().replaceAll('-', '')}`);
    const tokenRecordId = tokenId(randomUUID());
    const record = this.db.transaction(() => {
      const state = this.workingState();
      this.loadGrant(state, id, false);
      const token: Token = {
        id: tokenRecordId,
        grantId: id,
        label: label.trim() || 'unnamed token',
        hash: digest(value),
        expiresAt: state.grants[id]?.expiresAt ?? null,
        revokedAt: null,
      };
      const next = recordToken(state, token, now());
      this.db.insert(schema.tokens).values(next.tokens[tokenRecordId]).run();
      this.persistAuditDelta(state, next);
      return tokenRecord(this.db.select().from(schema.tokens)
        .where(eq(schema.tokens.id, tokenRecordId)).get()!);
    });
    return { record, value };
  }

  async revokeToken(id: TokenId) {
    this.db.transaction(() => {
      const state = this.workingState();
      const row = this.db.select().from(schema.tokens).where(eq(schema.tokens.id, id)).get();
      if (row) state.tokens[id] = tokenRecord(row);
      const next = revokeTokenRecord(state, id, now());
      this.db.update(schema.tokens).set({ revokedAt: next.tokens[id].revokedAt })
        .where(eq(schema.tokens.id, id)).run();
      this.persistAuditDelta(state, next);
    });
  }

  async revokeGrant(id: GrantId) {
    this.db.transaction(() => {
      const state = this.workingState();
      this.loadGrantBranch(state, id, false);
      const next = revokeGrantBranch(state, id, now());
      Object.values(next.grants).forEach((grant) => {
        if (grant.revokedAt !== state.grants[grant.id]?.revokedAt) {
          this.db.update(schema.grants).set({ revokedAt: grant.revokedAt })
            .where(eq(schema.grants.id, grant.id)).run();
        }
      });
      this.persistAuditDelta(state, next);
    });
  }

  async authorize(token: TokenValue, id: ResourceId, permission: Permission) {
    const at = now();
    return this.db.transaction(() => {
      const state = this.workingState();
      const requested = this.loadResource(state, id);
      if (requested && !requested.deletedAt) {
        const row = this.db.select().from(schema.tokens)
          .where(eq(schema.tokens.hash, digest(token))).orderBy(asc(schema.tokens.id)).get();
        if (row) {
          const record = tokenRecord(row);
          state.tokens[record.id] = record;
          this.loadGrantLineage(state, record.grantId);
          this.loadResourceAncestry(state, id);
          this.loadGrantResourceTargets(
            state,
            Object.values(state.grants).flatMap((grant) => grant.resources),
          );
        }
      }
      const decision = decide(state, digest(token), id, permission, at);
      this.appendAudit([{
        id: randomUUID(),
        at,
        action: 'authorize',
        target: id,
        result: decision.allowed ? 'allowed' : 'denied',
        detail: decision.detail,
      }]);
      return decision;
    });
  }

  async resolveBearer(token: TokenValue) {
    const at = now();
    const hash = digest(token);
    return this.db.transaction(() => {
      const state = this.workingState();
      const row = this.db.select().from(schema.tokens)
        .where(eq(schema.tokens.hash, hash)).orderBy(asc(schema.tokens.id)).get();
      if (row) {
        const record = tokenRecord(row);
        state.tokens[record.id] = record;
        this.loadGrantLineage(state, record.grantId);
      }
      return resolve(state, hash, at);
    });
  }

  async reset() {
    this.db.transaction(() => this.replace(structuredClone(this.initialState)));
  }

  /** Releases the connection. A `:memory:` database ceases to exist with it. */
  close() {
    this.connection.close();
  }

  private requireLiveResource(id: ResourceId) {
    const row = this.db.select().from(schema.resources).where(eq(schema.resources.id, id)).get();
    if (!row || row.deletedAt) throw new RgapError('missing_resource', 'Resource does not exist.');
  }

  private async recordInvocation(record: InvocationRecord) {
    this.db.transaction(() => {
      this.appendAudit([{
        id: randomUUID(),
        at: record.finishedAt,
        action: 'executable.invoke',
        target: record.resourceId,
        result: 'recorded',
        detail: JSON.stringify({
          runtime: record.runtime,
          grantLineageIds: record.grantLineage,
          bindingResourceIds: Object.values(record.bindings),
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          result: record.result,
        }),
      }]);
    });
  }

  /** Builds the command-local state expected by the pure rules without loading persisted records. */
  private workingState() {
    const state = emptyState();
    const auditCount = this.db.select({ value: count() }).from(schema.audit).get()?.value ?? 0;
    state.audit = new Array<AuditEvent>(auditCount);
    return state;
  }

  private loadResource(state: State, id: ResourceId) {
    const row = this.db.select().from(schema.resources).where(eq(schema.resources.id, id)).get();
    if (!row) return undefined;
    const resource = resourceRecord(row);
    state.resources[id] = resource;
    return resource;
  }

  private loadResourceAncestry(state: State, id: ResourceId) {
    const seen = new Set<string>();
    let current: ResourceId | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const resource = this.loadResource(state, current);
      current = resource?.parentId ?? null;
    }
  }

  private loadResourcePath(state: State, path: string, parentId: ResourceId | null = null) {
    let current = parentId;
    for (const name of pathParts(path)) {
      const row = this.db.select().from(schema.resources).where(and(
        current ? eq(schema.resources.parentId, current) : isNull(schema.resources.parentId),
        eq(schema.resources.name, name),
        isNull(schema.resources.deletedAt),
      )).orderBy(asc(schema.resources.id)).get();
      if (!row) break;
      const resource = resourceRecord(row);
      state.resources[resource.id] = resource;
      current = resource.id;
    }
  }

  /**
   * Loads path occupants and every occupied ID candidate that can affect the pure available-ID
   * rule. Once a missing prefix is found, later parents are IDs this same command will insert.
   */
  private prepareResourcePath(state: State, path: string, parentId: ResourceId | null) {
    if (parentId) this.loadResource(state, parentId);
    const reserved = new Set<string>();
    let current = parentId;
    let creating = false;
    for (const name of pathParts(path)) {
      if (!creating) {
        const row = this.db.select().from(schema.resources).where(and(
          current ? eq(schema.resources.parentId, current) : isNull(schema.resources.parentId),
          eq(schema.resources.name, name),
          isNull(schema.resources.deletedAt),
        )).orderBy(asc(schema.resources.id)).get();
        if (row) {
          const resource = resourceRecord(row);
          state.resources[resource.id] = resource;
          current = resource.id;
          continue;
        }
        creating = true;
      }

      const base = resourceIdBase(name);
      let candidate = base;
      let suffix = 2;
      while (reserved.has(candidate)) candidate = `${base}-${suffix++}`;
      while (true) {
        const row = this.db.select().from(schema.resources)
          .where(eq(schema.resources.id, candidate)).get();
        if (!row) break;
        state.resources[row.id] = resourceRecord(row);
        candidate = `${base}-${suffix++}`;
        while (reserved.has(candidate)) candidate = `${base}-${suffix++}`;
      }
      reserved.add(candidate);
      current = resourceId(candidate);
    }
  }

  private loadResourceBranch(state: State, id: ResourceId) {
    const queue: ResourceId[] = [id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const resource = this.loadResource(state, current);
      if (!resource) continue;
      let cursor: string | undefined;
      do {
        const rows = this.db.select().from(schema.resources).where(and(
          eq(schema.resources.parentId, current),
          cursor ? gt(schema.resources.id, cursor) : undefined,
        )).orderBy(asc(schema.resources.id)).limit(100).all();
        rows.forEach((row) => {
          const child = resourceRecord(row);
          state.resources[child.id] = child;
          queue.push(child.id);
        });
        cursor = rows.length === 100 ? rows.at(-1)!.id : undefined;
      } while (cursor);
    }
  }

  private loadGrant(state: State, id: GrantId, withResources = true) {
    const row = this.db.select().from(schema.grants).where(eq(schema.grants.id, id)).get();
    if (!row) return undefined;
    const grant = withResources ? this.grantRecord(row) : {
      id: grantId(row.id),
      name: row.name,
      parentId: row.parentId ? grantId(row.parentId) : null,
      resources: [],
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
    state.grants[id] = grant;
    return grant;
  }

  /**
   * Loads active grant-path occupants and every occupied ID candidate that can affect the pure
   * available-grant-ID rule. Missing prefixes are reserved in the order this command creates them.
   */
  private prepareGrantPath(
    state: State,
    path: string,
    parentId: GrantId | null,
    at: string,
  ) {
    if (parentId) this.loadGrant(state, parentId);
    const reserved = new Set<string>();
    let current = parentId;
    let creating = false;
    for (const name of pathParts(path)) {
      if (!creating) {
        const row = this.db.select().from(schema.grants).where(and(
          current ? eq(schema.grants.parentId, current) : isNull(schema.grants.parentId),
          eq(schema.grants.name, name),
        )).orderBy(asc(schema.grants.id)).all().find((candidate) => activeAt(candidate, at));
        if (row) {
          const grant = this.loadGrant(state, grantId(row.id));
          current = grant!.id;
          continue;
        }
        creating = true;
      }

      const base = grantIdBase(name);
      let candidate = base;
      let suffix = 2;
      while (reserved.has(candidate)) candidate = `${base}-${suffix++}`;
      while (true) {
        const row = this.db.select().from(schema.grants)
          .where(eq(schema.grants.id, candidate)).get();
        if (!row) break;
        this.loadGrant(state, grantId(row.id), false);
        candidate = `${base}-${suffix++}`;
        while (reserved.has(candidate)) candidate = `${base}-${suffix++}`;
      }
      reserved.add(candidate);
      current = grantId(candidate);
    }
  }

  private loadGrantLineage(state: State, id: GrantId) {
    const seen = new Set<string>();
    let current: GrantId | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const grant = this.loadGrant(state, current);
      current = grant?.parentId ?? null;
    }
  }

  private loadGrantBranch(state: State, id: GrantId, withResources = true) {
    const queue: GrantId[] = [id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const grant = this.loadGrant(state, current, withResources);
      if (!grant) continue;
      let cursor: string | undefined;
      do {
        const rows = this.db.select().from(schema.grants).where(and(
          eq(schema.grants.parentId, current),
          cursor ? gt(schema.grants.id, cursor) : undefined,
        )).orderBy(asc(schema.grants.id)).limit(100).all();
        rows.forEach((row) => {
          const childId = grantId(row.id);
          this.loadGrant(state, childId, withResources);
          queue.push(childId);
        });
        cursor = rows.length === 100 ? rows.at(-1)!.id : undefined;
      } while (cursor);
    }
  }

  private loadGrantResourceTargets(state: State, entries: GrantResource[]) {
    entries.forEach((entry) => {
      this.loadResourceAncestry(state, entry.id);
    });
  }

  private replaceGrantResources(grant: State['grants'][string]) {
    this.db.delete(schema.grantResourcePermissions)
      .where(eq(schema.grantResourcePermissions.grantId, grant.id)).run();
    this.db.delete(schema.grantResources)
      .where(eq(schema.grantResources.grantId, grant.id)).run();
    const entries = grant.resources.map((entry, position) => ({
      grantId: grant.id,
      position,
      id: entry.id,
    }));
    const carried = grant.resources.flatMap((entry, position) =>
      entry.permissions.map((permission) => ({ grantId: grant.id, position, permission })));
    insert(this.db, schema.grantResources, entries);
    insert(this.db, schema.grantResourcePermissions, carried);
  }

  private persistAuditDelta(before: State, after: State) {
    this.appendAudit(after.audit.slice(0, after.audit.length - before.audit.length));
  }

  /** Inserts newest-first events before the current minimum sequence without renumbering old rows. */
  private appendAudit(events: AuditEvent[]) {
    if (!events.length) return;
    const first = this.db.select({ seq: schema.audit.seq }).from(schema.audit)
      .orderBy(asc(schema.audit.seq)).limit(1).get();
    const start = first ? first.seq - events.length : 0;
    insert(this.db, schema.audit, events.map((event, index) => ({
      ...event,
      seq: start + index,
    })));
  }

  private grantRecord(row: typeof schema.grants.$inferSelect) {
    const permissionRows = this.db.select().from(schema.grantResourcePermissions)
      .where(eq(schema.grantResourcePermissions.grantId, row.id)).all();
    const held = new Map<number, Set<Permission>>();
    permissionRows.forEach(({ position, permission }) => {
      const set = held.get(position) ?? new Set<Permission>();
      set.add(permission);
      held.set(position, set);
    });
    const resources: GrantResource[] = this.db.select().from(schema.grantResources)
      .where(eq(schema.grantResources.grantId, row.id))
      .orderBy(asc(schema.grantResources.position)).all()
      .map((entry) => {
        const permissions = canonicalPermissions.filter((permission) => held.get(entry.position)?.has(permission));
        return { id: resourceId(entry.id), permissions };
      });
    return {
      id: grantId(row.id),
      name: row.name,
      parentId: row.parentId ? grantId(row.parentId) : null,
      resources,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  /** Replaces the stored rows with one complete state, writing parents before children. */
  private replace(state: State) {
    this.db.delete(schema.grantResourcePermissions).run();
    this.db.delete(schema.grantResources).run();
    this.db.delete(schema.tokens).run();
    this.db.delete(schema.executables).run();
    this.db.delete(schema.audit).run();
    this.db.delete(schema.grants).run();
    this.db.delete(schema.resources).run();

    insert(this.db, schema.resources, parentsFirst(state.resources, 'resource_cycle'));
    insert(this.db, schema.grants, parentsFirst(state.grants, 'grant_cycle').map((grant) => ({
      id: grant.id,
      name: grant.name,
      parentId: grant.parentId,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    })));

    const entries: (typeof schema.grantResources)['$inferInsert'][] = [];
    const carried: (typeof schema.grantResourcePermissions)['$inferInsert'][] = [];
    Object.values(state.grants).forEach((grant) => {
      grant.resources.forEach((entry, position) => {
        entries.push({
          grantId: grant.id,
          position,
          id: entry.id,
        });
        entry.permissions.forEach((permission) => {
          carried.push({ grantId: grant.id, position, permission });
        });
      });
    });
    insert(this.db, schema.grantResources, entries);
    insert(this.db, schema.grantResourcePermissions, carried);

    insert(this.db, schema.tokens, Object.values(state.tokens));
    insert(this.db, schema.executables, Object.values(state.executables));
    insert(this.db, schema.audit, state.audit.map((event, seq) => ({ ...event, seq })));
  }

  private isEmpty() {
    return [
      schema.resources, schema.grants, schema.tokens, schema.executables,
      schema.audit,
    ].every(
      (table) => this.db.select().from(table).limit(1).all().length === 0,
    );
  }
}

const emptyState = (): State => ({
  resources: {},
  grants: {},
  tokens: {},
  executables: {},
  audit: [],
});
const completeState = (state?: State): State => ({
  ...emptyState(),
  ...structuredClone(state ?? {}),
});
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: string) => tokenHash(hash(value));
const resourceIdBase = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resource';
const grantIdBase = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'grant';
const activeAt = (
  record: { expiresAt: string | null; revokedAt: string | null },
  at: string,
) => !record.revokedAt && (!record.expiresAt || record.expiresAt > at);
const grantRow = (grant: State['grants'][string]) => ({
  id: grant.id,
  name: grant.name,
  parentId: grant.parentId,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt,
});
const resourceRecord = (row: typeof schema.resources.$inferSelect) => ({
  id: resourceId(row.id),
  parentId: row.parentId ? resourceId(row.parentId) : null,
  name: row.name,
  deletedAt: row.deletedAt,
});
const tokenRecord = (row: typeof schema.tokens.$inferSelect) => ({
  id: tokenId(row.id),
  grantId: grantId(row.grantId),
  label: row.label,
  hash: tokenHash(row.hash),
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
});
const auditRecord = (row: typeof schema.audit.$inferSelect) => ({
  id: row.id,
  at: row.at,
  action: row.action,
  target: row.target as RecordId,
  result: row.result,
  detail: row.detail,
});
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
