import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import postgres, { type Options, type Sql } from 'postgres';
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PgTable } from 'drizzle-orm/pg-core';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import {
  authorize as decide,
  authorizeLineage,
  createAtPath,
  createGrantAtPath,
  deleteResource as removeResource,
  grantId,
  grantIdAtPath,
  guardCommands,
  invokeExecutable,
  updateResource as update,
  pageLimit,
  pathParts,
  permissions as canonicalPermissions,
  setResourceExecutable,
  recordToken,
  resourceId,
  resourceIdAtPath,
  resolveBearer as resolve,
  revokeGrant as revokeGrantBranch,
  revokeToken as revokeTokenRecord,
  RuntimeRegistry,
  setBindings as amendBindings,
  tokenHash,
  tokenId,
  tokenValue,
  repositoryFrom,
  RgapError,
  type GrantBinding,
  type AuditEvent,
  type CreateGrantInput,
  type ExecutableDefinition,
  type GrantId,
  type InvocationRecord,
  type InvokeInput,
  type JsonValue,
  type RuntimeRegistrations,
  type Permission,
  type AuditListQuery,
  type RecordId,
  type ResourceId,
  type ResourceListQuery,
  type ResourceWrite,
  type ResourceUpdate,
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

export type PostgresRgapStoreOptions = {
  /** PostgreSQL connection URL, including Hyperdrive-provided URLs. */
  url: string;
  /** What an empty database is initialized with, and what `reset` restores. */
  initialState?: State;
  /** Deployment-owned runtime implementations. They are configuration, not repository state. */
  runtimes?: RuntimeRegistry | RuntimeRegistrations;
  /** Postgres.js connection and pool options. */
  connection?: Options<{}>;
};

export class PostgresRgapStore implements RgapStore {
  private readonly repository: PostgresBackingRepository;

  constructor(options: PostgresRgapStoreOptions) {
    this.repository = new PostgresBackingRepository(options);
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

  /** Drains and releases the Postgres.js connection pool. */
  async migrate() {
    await this.repository.migrate();
  }

  async close() {
    await this.repository.close();
  }
}

class PostgresBackingRepository implements RgapCommands {
  private readonly connection: Sql;
  private readonly db: PostgresJsDatabase<typeof schema>;
  private readonly transactions = new AsyncLocalStorage<PostgresJsDatabase<typeof schema>>();
  private readonly initialState: State;
  private readonly runtimes: RuntimeRegistry;

  constructor(options: PostgresRgapStoreOptions) {
    this.initialState = completeState(options.initialState);
    this.runtimes = options.runtimes instanceof RuntimeRegistry
      ? options.runtimes
      : new RuntimeRegistry(options.runtimes);
    this.connection = postgres(options.url, options.connection);
    this.db = drizzle(this.connection, { schema });
  }

  private get database() {
    return this.transactions.getStore() ?? this.db;
  }

  async migrate() {
    await migrate(this.db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    await this.transaction(async () => {
      if (await this.isEmpty()) await this.replace(this.initialState);
    });
  }

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(
          (transaction) => this.transactions.run(
            transaction as PostgresJsDatabase<typeof schema>,
            operation,
          ),
          { isolationLevel: 'serializable' },
        );
      } catch (error) {
        if (attempt >= 4 || !retryableTransactionError(error)) throw error;
        await delay(2 ** attempt * 10);
      }
    }
  }

  async getResource(id: ResourceId) {
    const row = await this.database.select().from(schema.resources).where(eq(schema.resources.id, id)).then(firstRow);
    return row ? await this.resourceRecord(row) : undefined;
  }

  async listResources(query: ResourceListQuery) {
    const limit = pageLimit(query.limit);
    const parent = query.parentId === null
      ? isNull(schema.resources.parentId)
      : eq(schema.resources.parentId, query.parentId);
    const rows = await this.database.select().from(schema.resources)
      .where(and(parent, isNull(schema.resources.deletedAt), query.cursor ? gt(schema.resources.id, query.cursor) : undefined))
      .orderBy(asc(schema.resources.id)).limit(limit);
    return await Promise.all(rows.map((row) => this.resourceRecord(row)));
  }

  async getGrant(id: GrantId) {
    const row = await this.database.select().from(schema.grants).where(eq(schema.grants.id, id)).then(firstRow);
    return row ? await this.grantRecord(row) : undefined;
  }

  async listGrants(query: GrantListQuery = {}) {
    const limit = pageLimit(query.limit);
    const parent = query.parentId === undefined
      ? undefined
      : query.parentId === null ? isNull(schema.grants.parentId) : eq(schema.grants.parentId, query.parentId);
    const rows = await this.database.select().from(schema.grants)
      .where(and(parent, query.cursor ? gt(schema.grants.id, query.cursor) : undefined))
      .orderBy(asc(schema.grants.id)).limit(limit);
    return await Promise.all(rows.map((row) => this.grantRecord(row)));
  }

  async getToken(id: TokenId) {
    const row = await this.database.select().from(schema.tokens).where(eq(schema.tokens.id, id)).then(firstRow);
    return row ? tokenRecord(row) : undefined;
  }

  async listTokens(query: TokenListQuery = {}) {
    const limit = pageLimit(query.limit);
    const rows = await this.database.select().from(schema.tokens)
      .where(and(
        query.grantId === undefined ? undefined : eq(schema.tokens.grantId, query.grantId),
        query.cursor ? gt(schema.tokens.id, query.cursor) : undefined,
      ))
      .orderBy(asc(schema.tokens.id)).limit(limit);
    return rows.map(tokenRecord);
  }

  async listAudit(query: AuditListQuery = {}) {
    const limit = pageLimit(query.limit);
    let after: number | undefined;
    if (query.cursor) {
      const cursor = await this.database.select({ seq: schema.audit.seq }).from(schema.audit)
        .where(eq(schema.audit.id, query.cursor)).then(firstRow);
      if (!cursor) throw new RgapError('invalid_cursor', 'The collection cursor is unknown.');
      after = cursor.seq;
    }
    const rows = await this.database.select().from(schema.audit)
      .where(after === undefined ? undefined : gt(schema.audit.seq, after))
      .orderBy(asc(schema.audit.seq)).limit(limit);
    return rows.map(auditRecord);
  }

  async createResource(input: ResourceWrite & { parentId: ResourceId | null }) {
    return await this.transaction(async () => {
      const at = now();
      const state = await this.workingState();
      await this.prepareResourcePath(state, input.name, input.parentId);
      for (const boundId of Object.values(input.executable?.bind ?? {})) {
        await this.loadResource(state, boundId);
      }
      const before = new Set(Object.keys(state.resources));
      let next = createAtPath(state, input.name, input.parentId, at);
      const id = resourceIdAtPath(next.resources, input.name, input.parentId);
      if (!id) throw new RgapError('invalid_name', 'Resource name is required.');
      if (input.executable) {
        next = setResourceExecutable(next, id, input.executable, this.runtimes);
      }
      const created = Object.values(next.resources).filter((resource) => !before.has(resource.id));
      await insert(this.database, schema.resources, parentsFirst(
        Object.fromEntries(created.map((resource) => [resource.id, resource])),
        'resource_cycle',
      ).map(resourceRow));
      if (next.resources[id].executable) await this.storeExecutable(id, next.resources[id].executable);
      await this.persistAuditDelta(state, next);
      return await this.resourceRecord((await this.database.select().from(schema.resources).where(eq(schema.resources.id, id)).then(firstRow))!);
    });
  }

  async updateResource(id: ResourceId, input: ResourceUpdate) {
    return await this.transaction(async () => {
      const at = now();
      const state = await this.workingState();
      const resource = await this.loadResource(state, id);
      if (!resource) throw new RgapError('missing_resource', 'Resource does not exist.');
      const destination = input.parentId === undefined ? resource.parentId : input.parentId;
      if (destination) await this.loadResourceAncestry(state, destination);
      await this.loadResourceChildren(state, destination);
      if (input.executable) {
        await this.loadResourceChildren(state, id);
        for (const boundId of Object.values(input.executable.bind ?? {})) await this.loadResource(state, boundId);
      }
      const metadata = input.name === undefined && input.parentId === undefined
        ? { name: resource.name }
        : { name: input.name, parentId: input.parentId };
      let next = update(state, id, metadata, at);
      if (input.executable) {
        next = setResourceExecutable(next, id, input.executable, this.runtimes);
      }
      const updated = next.resources[id];
      await this.database.update(schema.resources)
        .set({ name: updated.name, parentId: updated.parentId })
        .where(eq(schema.resources.id, id));
      if (updated.executable) await this.storeExecutable(id, updated.executable);
      await this.persistAuditDelta(state, next);
      return await this.resourceRecord((await this.database.select().from(schema.resources).where(eq(schema.resources.id, id)).then(firstRow))!);
    });
  }

  async deleteResource(id: ResourceId) {
    await this.transaction(async () => {
      const state = await this.workingState();
      await this.loadResourceBranch(state, id);
      const next = removeResource(state, id, now());
      for (const resource of Object.values(next.resources)) {
        if (resource.deletedAt !== state.resources[resource.id]?.deletedAt) {
          await this.database.update(schema.resources)
            .set({ deletedAt: resource.deletedAt })
            .where(eq(schema.resources.id, resource.id));
        }
      }
      const removed = Object.values(next.resources).filter((resource) =>
        resource.deletedAt !== state.resources[resource.id]?.deletedAt
      );
      for (const resource of removed) {
        await this.database.delete(schema.executableBindings)
          .where(eq(schema.executableBindings.executableResourceId, resource.id));
        await this.database.delete(schema.executables).where(eq(schema.executables.resourceId, resource.id));
      }
      await this.persistAuditDelta(state, next);
    });
  }

  invoke(id: ResourceId, input: InvokeInput) {
    const repository = this;
    return (async function* () {
      yield* invokeExecutable({
        getDefinition: async (resource) => (await repository.getResource(resource))?.executable ?? undefined,
        authorize: async (resource, permission, recorded) => {
          if (recorded === null) {
            await repository.requireLiveResource(resource);
            return { lineage: [] };
          }
          return await repository.transaction(async () => {
            const state = await repository.workingState();
            await repository.loadResourceAncestry(state, resource);
            for (const grant of recorded) await repository.loadGrant(state, grant);
            await repository.loadGrantBindingTargets(
              state,
              recorded.flatMap((grant) => state.grants[grant]?.bindings ?? []),
            );
            const decision = authorizeLineage(state, recorded, resource, permission, now());
            if (!decision.allowed) throw new RgapError('unauthorized', decision.detail);
            return { lineage: decision.lineage };
          });
        },
        runtimes: repository.runtimes,
        createInvocationId: randomUUID,
        recordInvocation: (record) => repository.recordInvocation(record),
      }, id, input);
    })();
  }

  async createGrant(input: CreateGrantInput) {
    return await this.transaction(async () => {
      const at = now();
      const state = await this.workingState();
      await this.prepareGrantPath(state, input.name, input.parentId, at);
      await this.loadGrantBindingTargets(state, [
        ...input.bindings,
        ...Object.values(state.grants).flatMap((grant) => grant.bindings),
      ]);
      const before = new Set(Object.keys(state.grants));
      const { parentId, ...write } = input;
      const next = createGrantAtPath(state, write, parentId, at);
      const id = grantIdAtPath(next.grants, input.name, parentId, at);
      if (!id) throw new RgapError('invalid_grant', 'Grant name is required.');
      const created = Object.values(next.grants).filter((grant) => !before.has(grant.id));
      await insert(this.database, schema.grants, parentsFirst(
        Object.fromEntries(created.map((grant) => [grant.id, grant])),
        'grant_cycle',
      ).map(grantRow));
      for (const grant of created) await this.replaceGrantBindings(grant);
      await this.persistAuditDelta(state, next);
      return await this.grantRecord((await this.database.select().from(schema.grants).where(eq(schema.grants.id, id)).then(firstRow))!);
    });
  }

  async setBindings(id: GrantId, bindings: GrantBinding[]) {
    return await this.transaction(async () => {
      const state = await this.workingState();
      const grant = await this.loadGrant(state, id);
      if (grant?.parentId) await this.loadGrant(state, grant.parentId);
      await this.loadGrantBranch(state, id);
      const directChildren = Object.values(state.grants)
        .filter((candidate) => candidate.parentId === id);
      await this.loadGrantBindingTargets(state, [
        ...bindings,
        ...(grant?.parentId ? state.grants[grant.parentId]?.bindings ?? [] : []),
        ...directChildren.flatMap((child) => child.bindings),
      ]);
      const next = amendBindings(state, id, bindings, now());
      await this.replaceGrantBindings(next.grants[id]);
      for (const candidate of Object.values(next.grants)) {
        if (candidate.revokedAt !== state.grants[candidate.id]?.revokedAt) {
          await this.database.update(schema.grants).set({ revokedAt: candidate.revokedAt })
            .where(eq(schema.grants.id, candidate.id));
        }
      }
      await this.persistAuditDelta(state, next);
      return await this.grantRecord((await this.database.select().from(schema.grants).where(eq(schema.grants.id, id)).then(firstRow))!);
    });
  }

  async issueToken(id: GrantId, label: string) {
    const value = tokenValue(`rgap_${randomUUID().replaceAll('-', '')}`);
    const tokenRecordId = tokenId(randomUUID());
    const record = await this.transaction(async () => {
      const state = await this.workingState();
      await this.loadGrant(state, id, false);
      const token: Token = {
        id: tokenRecordId,
        grantId: id,
        label: label.trim() || 'unnamed token',
        hash: digest(value),
        expiresAt: state.grants[id]?.expiresAt ?? null,
        revokedAt: null,
      };
      const next = recordToken(state, token, now());
      await this.database.insert(schema.tokens).values(next.tokens[tokenRecordId]);
      await this.persistAuditDelta(state, next);
      return tokenRecord((await this.database.select().from(schema.tokens)
        .where(eq(schema.tokens.id, tokenRecordId)).then(firstRow))!);
    });
    return { record, value };
  }

  async revokeToken(id: TokenId) {
    await this.transaction(async () => {
      const state = await this.workingState();
      const row = await this.database.select().from(schema.tokens).where(eq(schema.tokens.id, id)).then(firstRow);
      if (row) state.tokens[id] = tokenRecord(row);
      const next = revokeTokenRecord(state, id, now());
      await this.database.update(schema.tokens).set({ revokedAt: next.tokens[id].revokedAt })
        .where(eq(schema.tokens.id, id));
      await this.persistAuditDelta(state, next);
    });
  }

  async revokeGrant(id: GrantId) {
    await this.transaction(async () => {
      const state = await this.workingState();
      await this.loadGrantBranch(state, id, false);
      const next = revokeGrantBranch(state, id, now());
      for (const grant of Object.values(next.grants)) {
        if (grant.revokedAt !== state.grants[grant.id]?.revokedAt) {
          await this.database.update(schema.grants).set({ revokedAt: grant.revokedAt })
            .where(eq(schema.grants.id, grant.id));
        }
      }
      await this.persistAuditDelta(state, next);
    });
  }

  async authorize(token: TokenValue, id: ResourceId, permission: Permission) {
    const at = now();
    return await this.transaction(async () => {
      const state = await this.workingState();
      const requested = await this.loadResource(state, id);
      if (requested && !requested.deletedAt) {
        const row = await this.database.select().from(schema.tokens)
          .where(eq(schema.tokens.hash, digest(token))).orderBy(asc(schema.tokens.id)).then(firstRow);
        if (row) {
          const record = tokenRecord(row);
          state.tokens[record.id] = record;
          await this.loadGrantLineage(state, record.grantId);
          await this.loadResourceAncestry(state, id);
          await this.loadGrantBindingTargets(
            state,
            Object.values(state.grants).flatMap((grant) => grant.bindings),
          );
        }
      }
      const decision = decide(state, digest(token), id, permission, at);
      await this.appendAudit([{
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
    return await this.transaction(async () => {
      const state = await this.workingState();
      const row = await this.database.select().from(schema.tokens)
        .where(eq(schema.tokens.hash, hash)).orderBy(asc(schema.tokens.id)).then(firstRow);
      if (row) {
        const record = tokenRecord(row);
        state.tokens[record.id] = record;
        await this.loadGrantLineage(state, record.grantId);
      }
      return resolve(state, hash, at);
    });
  }

  async reset() {
    await this.transaction(async () => await this.replace(structuredClone(this.initialState)));
  }

  /** Drains and releases the Postgres.js connection pool. */
  async close() {
    await this.connection.end();
  }

  private async requireLiveResource(id: ResourceId) {
    const row = await this.database.select().from(schema.resources).where(eq(schema.resources.id, id)).then(firstRow);
    if (!row || row.deletedAt) throw new RgapError('missing_resource', 'Resource does not exist.');
  }

  private async recordInvocation(record: InvocationRecord) {
    await this.transaction(async () => {
      await this.appendAudit([{
        id: record.id,
        at: record.finishedAt,
        action: 'executable.invoke',
        target: record.resourceId,
        result: 'recorded',
        detail: JSON.stringify({
          runtime: record.runtime,
          grantLineageIds: record.grantLineage,
          parentInvocationId: record.parentInvocationId,
          bindingResourceIds: Object.values(record.bindings),
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          result: record.result,
        }),
      }]);
    });
  }

  /** Builds the command-local state expected by the pure rules without loading persisted records. */
  private async workingState() {
    const state = emptyState();
    const auditCount = (await this.database.select({ value: count() })
      .from(schema.audit).then(firstRow))?.value ?? 0;
    state.audit = new Array<AuditEvent>(auditCount);
    return state;
  }

  private async loadResource(state: State, id: ResourceId) {
    const row = await this.database.select().from(schema.resources).where(eq(schema.resources.id, id)).then(firstRow);
    if (!row) return undefined;
    const resource = await this.resourceRecord(row);
    state.resources[id] = resource;
    return resource;
  }

  private async loadResourceAncestry(state: State, id: ResourceId) {
    const seen = new Set<string>();
    let current: ResourceId | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const resource = await this.loadResource(state, current);
      current = resource?.parentId ?? null;
    }
  }

  private async loadResourceChildren(state: State, parentId: ResourceId | null) {
    const rows = await this.database.select().from(schema.resources).where(
      parentId === null
        ? isNull(schema.resources.parentId)
        : eq(schema.resources.parentId, parentId),
    ).orderBy(asc(schema.resources.id));
    for (const row of rows) {
      const resource = await this.resourceRecord(row);
      state.resources[resource.id] = resource;
    }
  }

  private async loadResourcePath(state: State, path: string, parentId: ResourceId | null = null) {
    let current = parentId;
    for (const name of pathParts(path)) {
      const row = await this.database.select().from(schema.resources).where(and(
        current ? eq(schema.resources.parentId, current) : isNull(schema.resources.parentId),
        eq(schema.resources.name, name),
        isNull(schema.resources.deletedAt),
      )).orderBy(asc(schema.resources.id)).then(firstRow);
      if (!row) break;
      const resource = await this.resourceRecord(row);
      state.resources[resource.id] = resource;
      current = resource.id;
    }
  }

  /**
   * Loads path occupants and every occupied ID candidate that can affect the pure available-ID
   * rule. Once a missing prefix is found, later parents are IDs this same command will insert.
   */
  private async prepareResourcePath(state: State, path: string, parentId: ResourceId | null) {
    if (parentId) await this.loadResource(state, parentId);
    const reserved = new Set<string>();
    let current = parentId;
    let creating = false;
    for (const name of pathParts(path)) {
      if (!creating) {
        const row = await this.database.select().from(schema.resources).where(and(
          current ? eq(schema.resources.parentId, current) : isNull(schema.resources.parentId),
          eq(schema.resources.name, name),
          isNull(schema.resources.deletedAt),
        )).orderBy(asc(schema.resources.id)).then(firstRow);
        if (row) {
          const resource = await this.resourceRecord(row);
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
        const row = await this.database.select().from(schema.resources)
          .where(eq(schema.resources.id, candidate)).then(firstRow);
        if (!row) break;
        state.resources[row.id] = await this.resourceRecord(row);
        candidate = `${base}-${suffix++}`;
        while (reserved.has(candidate)) candidate = `${base}-${suffix++}`;
      }
      reserved.add(candidate);
      current = resourceId(candidate);
    }
  }

  private async loadResourceBranch(state: State, id: ResourceId) {
    const queue: ResourceId[] = [id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const resource = await this.loadResource(state, current);
      if (!resource) continue;
      let cursor: string | undefined;
      do {
        const rows = await this.database.select().from(schema.resources).where(and(
          eq(schema.resources.parentId, current),
          cursor ? gt(schema.resources.id, cursor) : undefined,
        )).orderBy(asc(schema.resources.id)).limit(100);
        for (const row of rows) {
          const child = await this.resourceRecord(row);
          state.resources[child.id] = child;
          queue.push(child.id);
        }
        cursor = rows.length === 100 ? rows.at(-1)!.id : undefined;
      } while (cursor);
    }
  }

  private async loadGrant(state: State, id: GrantId, withBindings = true) {
    const row = await this.database.select().from(schema.grants).where(eq(schema.grants.id, id)).then(firstRow);
    if (!row) return undefined;
    const grant = withBindings ? await this.grantRecord(row) : {
      id: grantId(row.id),
      name: row.name,
      parentId: row.parentId ? grantId(row.parentId) : null,
      bindings: [],
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
  private async prepareGrantPath(
    state: State,
    path: string,
    parentId: GrantId | null,
    at: string,
  ) {
    if (parentId) await this.loadGrant(state, parentId);
    const reserved = new Set<string>();
    let current = parentId;
    let creating = false;
    for (const name of pathParts(path)) {
      if (!creating) {
        const rows = await this.database.select().from(schema.grants).where(and(
          current ? eq(schema.grants.parentId, current) : isNull(schema.grants.parentId),
          eq(schema.grants.name, name),
        )).orderBy(asc(schema.grants.id));
        const row = rows.find((candidate) => activeAt(candidate, at));
        if (row) {
          const grant = await this.loadGrant(state, grantId(row.id));
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
        const row = await this.database.select().from(schema.grants)
          .where(eq(schema.grants.id, candidate)).then(firstRow);
        if (!row) break;
        await this.loadGrant(state, grantId(row.id), false);
        candidate = `${base}-${suffix++}`;
        while (reserved.has(candidate)) candidate = `${base}-${suffix++}`;
      }
      reserved.add(candidate);
      current = grantId(candidate);
    }
  }

  private async loadGrantLineage(state: State, id: GrantId) {
    const seen = new Set<string>();
    let current: GrantId | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const grant = await this.loadGrant(state, current);
      current = grant?.parentId ?? null;
    }
  }

  private async loadGrantBranch(state: State, id: GrantId, withBindings = true) {
    const queue: GrantId[] = [id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const grant = await this.loadGrant(state, current, withBindings);
      if (!grant) continue;
      let cursor: string | undefined;
      do {
        const rows = await this.database.select().from(schema.grants).where(and(
          eq(schema.grants.parentId, current),
          cursor ? gt(schema.grants.id, cursor) : undefined,
        )).orderBy(asc(schema.grants.id)).limit(100);
        for (const row of rows) {
          const childId = grantId(row.id);
          await this.loadGrant(state, childId, withBindings);
          queue.push(childId);
        }
        cursor = rows.length === 100 ? rows.at(-1)!.id : undefined;
      } while (cursor);
    }
  }

  private async loadGrantBindingTargets(state: State, bindings: GrantBinding[]) {
    for (const binding of bindings) await this.loadResourceAncestry(state, binding.id);
  }

  private async replaceGrantBindings(grant: State['grants'][string]) {
    await this.database.delete(schema.grantBindingPermissions)
      .where(eq(schema.grantBindingPermissions.grantId, grant.id));
    await this.database.delete(schema.grantBindings)
      .where(eq(schema.grantBindings.grantId, grant.id));
    const bindings = grant.bindings.map((binding, position) => ({
      grantId: grant.id,
      position,
      id: binding.id,
    }));
    const carried = grant.bindings.flatMap((binding, position) =>
      binding.permissions.map((permission) => ({ grantId: grant.id, position, permission })));
    await insert(this.database, schema.grantBindings, bindings);
    await insert(this.database, schema.grantBindingPermissions, carried);
  }

  private async persistAuditDelta(before: State, after: State) {
    await this.appendAudit(after.audit.slice(0, after.audit.length - before.audit.length));
  }

  /** Inserts newest-first events before the current minimum sequence without renumbering old rows. */
  private async appendAudit(events: AuditEvent[]) {
    if (!events.length) return;
    const first = await this.database.select({ seq: schema.audit.seq }).from(schema.audit)
      .orderBy(asc(schema.audit.seq)).limit(1).then(firstRow);
    const start = first ? first.seq - events.length : 0;
    await insert(this.database, schema.audit, events.map((event, index) => ({
      ...event,
      seq: start + index,
    })));
  }

  private async executableDefinition(id: ResourceId): Promise<ExecutableDefinition | null> {
    const row = await this.database.select().from(schema.executables)
      .where(eq(schema.executables.resourceId, id)).then(firstRow);
    if (!row) return null;
    const bindingRows = await this.database.select().from(schema.executableBindings)
      .where(eq(schema.executableBindings.executableResourceId, id))
      .orderBy(asc(schema.executableBindings.name));
    const bind = Object.fromEntries(bindingRows.map((binding) => [binding.name, {
        resourceId: resourceId(binding.resourceId),
        grantLineage: binding.grantLineage === null
          ? null
          : parseGrantLineage(binding.grantLineage),
      }]));
    return {
      runtime: row.runtime,
      input: parseExecutableInput(row.input),
      bind,
    };
  }

  private async resourceRecord(row: typeof schema.resources.$inferSelect) {
    return resourceRecord(row, await this.executableDefinition(resourceId(row.id)));
  }

  private async grantRecord(row: typeof schema.grants.$inferSelect) {
    const permissionRows = await this.database.select().from(schema.grantBindingPermissions)
      .where(eq(schema.grantBindingPermissions.grantId, row.id));
    const held = new Map<number, Set<Permission>>();
    permissionRows.forEach(({ position, permission }) => {
      const set = held.get(position) ?? new Set<Permission>();
      set.add(permission);
      held.set(position, set);
    });
    const bindingRows = await this.database.select().from(schema.grantBindings)
      .where(eq(schema.grantBindings.grantId, row.id))
      .orderBy(asc(schema.grantBindings.position));
    const bindings: GrantBinding[] = bindingRows.map((binding) => {
        const permissions = canonicalPermissions.filter((permission) => held.get(binding.position)?.has(permission));
        return { id: resourceId(binding.id), permissions };
      });
    return {
      id: grantId(row.id),
      name: row.name,
      parentId: row.parentId ? grantId(row.parentId) : null,
      bindings,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  private async storeExecutable(id: ResourceId, definition: ExecutableDefinition) {
    await this.database.insert(schema.executables).values({
      resourceId: id,
      runtime: definition.runtime,
      input: JSON.stringify(definition.input),
    })
      .onConflictDoUpdate({
        target: schema.executables.resourceId,
        set: {
          runtime: definition.runtime,
          input: JSON.stringify(definition.input),
        },
      });
    await this.database.delete(schema.executableBindings)
      .where(eq(schema.executableBindings.executableResourceId, id));
    await insert(this.database, schema.executableBindings, Object.entries(definition.bind).map(([name, binding]) => ({
      executableResourceId: id,
      name,
      resourceId: binding.resourceId,
      grantLineage: binding.grantLineage === null
        ? null
        : JSON.stringify(binding.grantLineage),
    })));
  }

  /** Replaces the stored rows with one complete state, writing parents before children. */
  private async replace(state: State) {
    await this.database.delete(schema.grantBindingPermissions);
    await this.database.delete(schema.grantBindings);
    await this.database.delete(schema.tokens);
    await this.database.delete(schema.executableBindings);
    await this.database.delete(schema.executables);
    await this.database.delete(schema.audit);
    await this.database.delete(schema.grants);
    await this.database.delete(schema.resources);

    await insert(this.database, schema.resources, parentsFirst(state.resources, 'resource_cycle').map(resourceRow));
    await insert(this.database, schema.grants, parentsFirst(state.grants, 'grant_cycle').map((grant) => ({
      id: grant.id,
      name: grant.name,
      parentId: grant.parentId,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    })));

    const bindings: (typeof schema.grantBindings)['$inferInsert'][] = [];
    const carried: (typeof schema.grantBindingPermissions)['$inferInsert'][] = [];
    Object.values(state.grants).forEach((grant) => {
      grant.bindings.forEach((binding, position) => {
        bindings.push({
          grantId: grant.id,
          position,
          id: binding.id,
        });
        binding.permissions.forEach((permission) => {
          carried.push({ grantId: grant.id, position, permission });
        });
      });
    });
    await insert(this.database, schema.grantBindings, bindings);
    await insert(this.database, schema.grantBindingPermissions, carried);

    await insert(this.database, schema.tokens, Object.values(state.tokens));
    const executableResources = Object.values(state.resources).flatMap((resource) =>
      resource.executable ? [{ resource, definition: resource.executable }] : []
    );
    await insert(this.database, schema.executables, executableResources.map(({ resource, definition }) => ({
      resourceId: resource.id,
      runtime: definition.runtime,
      input: JSON.stringify(definition.input),
    })));
    await insert(this.database, schema.executableBindings, executableResources.flatMap(({ resource, definition }) =>
      Object.entries(definition.bind).map(([name, binding]) => ({
        executableResourceId: resource.id,
        name,
        resourceId: binding.resourceId,
        grantLineage: binding.grantLineage === null
          ? null
          : JSON.stringify(binding.grantLineage),
      }))
    ));
    await insert(this.database, schema.audit, state.audit.map((event, seq) => ({ ...event, seq })));
  }

  private async isEmpty() {
    for (const table of [
      schema.resources, schema.grants, schema.tokens, schema.executables,
      schema.executableBindings, schema.audit,
    ]) {
      if ((await this.database.select().from(table).limit(1)).length) return false;
    }
    return true;
  }
}

const emptyState = (): State => ({
  resources: {},
  grants: {},
  tokens: {},
  audit: [],
});
const completeState = (state?: State): State => ({
  ...emptyState(),
  ...structuredClone(state ?? {}),
});
const firstRow = <T>(rows: T[]) => rows[0];
const retryableTransactionError = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === '40001' || code === '40P01';
};
const delay = (milliseconds: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: string) => tokenHash(hash(value));
const parseExecutableInput = (value: string): Record<string, JsonValue> => {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonObject(parsed)) {
    throw new RgapError('invalid_executable_input', 'Stored executable input is invalid.');
  }
  return parsed;
};
const isJsonValue = (value: unknown): value is JsonValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every(isJsonValue)) ||
  isJsonObject(value);
const isJsonObject = (value: unknown): value is Record<string, JsonValue> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(isJsonValue);
const parseGrantLineage = (value: string): GrantId[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
    throw new RgapError('invalid_binding_lineage', 'Executable binding lineage is invalid.');
  }
  return parsed.map(grantId);
};
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
const resourceRecord = (
  row: typeof schema.resources.$inferSelect,
  executable: ExecutableDefinition | null = null,
) => ({
  id: resourceId(row.id),
  parentId: row.parentId ? resourceId(row.parentId) : null,
  name: row.name,
  deletedAt: row.deletedAt,
  executable,
});
const resourceRow = (resource: State['resources'][string]) => ({
  id: resource.id,
  parentId: resource.parentId,
  name: resource.name,
  deletedAt: resource.deletedAt,
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
async function insert<T extends PgTable>(
  db: PostgresJsDatabase<any>,
  table: T,
  rows: T['$inferInsert'][],
) {
  for (let index = 0; index < rows.length; index += 100) {
    await db.insert(table).values(rows.slice(index, index + 100));
  }
}
