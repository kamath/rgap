import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  authorize as decide,
  availableId,
  createGrant as addGrant,
  createResource as addResource,
  deleteExecutable as removeExecutable,
  deleteResource as removeResource,
  deleteSecretMetadata,
  executableRevisionId,
  grantId,
  getAuthorizedLineage,
  guardCommands,
  inspectAuthority,
  invokeExecutable,
  isPathCapability,
  moveResource as move,
  pageLimit,
  permissions as canonicalPermissions,
  publishExecutable as addExecutableRevision,
  recordRuntimePrivateMetadata,
  recordSecretMetadata,
  recordToken,
  resourceId,
  revokeGrant as revokeGrantBranch,
  revokeToken as revokeTokenRecord,
  RuntimeRegistry,
  runtimeMetadataKey,
  setCapabilities as amendCapabilities,
  tokenHash,
  tokenId,
  tokenValue,
  repositoryFrom,
  RgapError,
  type Capability,
  type CreateGrantInput,
  type CreateResourceInput,
  type ExecutableRevisionId,
  type ExecutionLimits,
  type GrantId,
  type InvocationRecord,
  type InvokeInput,
  type InvokeRuntime,
  type JsonSchemaValidator,
  type Permission,
  type PublishExecutableInput,
  type AuditListQuery,
  type RecordId,
  type ResourceId,
  type ResourceListQuery,
  type RgapCommands,
  type RgapRepository,
  type RgapStore,
  type RuntimeCredentialStore,
  type SecretStore,
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
  runtimes?: RuntimeRegistry | Readonly<Record<string, InvokeRuntime>>;
  /** Host JSON Schema implementation used at invocation boundaries. */
  validator?: JsonSchemaValidator;
  /** Per-runtime host ceilings. An omitted runtime has no configured ceilings. */
  runtimeLimits?: Readonly<Record<string, ExecutionLimits>> | ((runtime: string) => ExecutionLimits);
  /** Protected-value persistence. SQLite receives only the metadata it returns. */
  secrets?: SecretStore;
  /** Runtime-private persistence. SQLite receives only synchronized public metadata. */
  credentials?: RuntimeCredentialStore;
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
    return guardCommands(repositoryFrom(this.repository), token);
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
  private readonly validator: JsonSchemaValidator;
  private readonly runtimeLimits: (runtime: string) => ExecutionLimits;
  private readonly secrets: SecretStore;
  private readonly credentials: RuntimeCredentialStore;

  constructor(options: SqliteRgapStoreOptions = {}) {
    this.initialState = completeState(options.initialState);
    this.runtimes = options.runtimes instanceof RuntimeRegistry
      ? options.runtimes
      : new RuntimeRegistry(options.runtimes);
    this.validator = options.validator ?? unavailableValidator;
    const configuredLimits = options.runtimeLimits;
    this.runtimeLimits = typeof configuredLimits === 'function'
      ? configuredLimits
      : (runtime) => structuredClone(configuredLimits?.[runtime] ?? {});
    this.secrets = options.secrets ?? unavailableSecrets;
    this.credentials = options.credentials ?? unavailableCredentials;
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
    return this.commit((state) => {
      const id = availableId(state, input.name);
      return { state: addResource(state, input, id, now()), pick: (committed) => committed.resources[id] };
    });
  }

  async moveResource(id: ResourceId, parentId: ResourceId | null) {
    return this.commit((state) => ({
      state: move(state, id, parentId, now()),
      pick: (committed) => committed.resources[id],
    }));
  }

  async deleteResource(id: ResourceId) {
    this.commit((state) => ({ state: removeResource(state, id, now()), pick: () => undefined }));
  }

  async getExecutable(id: ResourceId) {
    const row = this.db.select().from(schema.executables).where(eq(schema.executables.resourceId, id)).get();
    return row ? {
      resourceId: resourceId(row.resourceId),
      activeRevisionId: row.activeRevisionId ? executableRevisionId(row.activeRevisionId) : null,
      deletedAt: row.deletedAt,
    } : undefined;
  }

  async getExecutableRevision(id: ExecutableRevisionId) {
    const row = this.db.select().from(schema.executableRevisions)
      .where(eq(schema.executableRevisions.id, id)).get();
    return row ? executableRevisionRecord(row) : undefined;
  }

  async listExecutableRevisions(id: ResourceId) {
    return this.db.select().from(schema.executableRevisions)
      .where(eq(schema.executableRevisions.resourceId, id))
      .orderBy(asc(schema.executableRevisions.createdAt), asc(schema.executableRevisions.id))
      .all().map(executableRevisionRecord);
  }

  async publishExecutable(id: ResourceId, input: PublishExecutableInput) {
    const revisionId = executableRevisionId(randomUUID());
    return this.commit((state) => ({
      state: addExecutableRevision(
        state, id, input, revisionId, now(),
        (runtime, program) => this.runtimes.get(runtime).validate(program),
      ),
      pick: (committed) => committed.executableRevisions[revisionId],
    }));
  }

  async deleteExecutable(id: ResourceId) {
    this.commit((state) => ({ state: removeExecutable(state, id, now()), pick: () => undefined }));
  }

  async getSecretMetadata(id: ResourceId) {
    const row = this.db.select().from(schema.secretMetadata)
      .where(eq(schema.secretMetadata.resourceId, id)).get();
    return row ? {
      resourceId: resourceId(row.resourceId), version: row.version, updatedAt: row.updatedAt,
    } : undefined;
  }

  async writeSecret(id: ResourceId, value: string) {
    this.requireLiveResource(id);
    const metadata = await this.secrets.write(id, value);
    if (metadata.resourceId !== id) {
      throw new RgapError('invalid_secret_metadata', 'Secret store returned metadata for another resource.');
    }
    return this.commit((state) => ({
      state: recordSecretMetadata(state, metadata),
      pick: (committed) => committed.secretMetadata[id],
    }));
  }

  async deleteSecret(id: ResourceId) {
    this.requireLiveResource(id);
    await this.secrets.delete(id);
    this.commit((state) => ({ state: deleteSecretMetadata(state, id), pick: () => undefined }));
  }

  async getRuntimePrivateMetadata(runtime: string, id: ResourceId) {
    const row = this.db.select().from(schema.runtimePrivateMetadata).where(and(
      eq(schema.runtimePrivateMetadata.runtime, runtime),
      eq(schema.runtimePrivateMetadata.resourceId, id),
    )).get();
    return row ? {
      runtime: row.runtime, resourceId: resourceId(row.resourceId), version: row.version, updatedAt: row.updatedAt,
    } : undefined;
  }

  invoke(id: ResourceId, input: InvokeInput) {
    const repository = this;
    return (async function* () {
      // Surface an absent deployment runtime before another optional host service obscures it.
      const definition = await repository.getExecutable(id);
      const revisionId = input.revisionId ?? definition?.activeRevisionId;
      const revision = revisionId ? await repository.getExecutableRevision(revisionId) : undefined;
      if (revision?.resourceId === id) repository.runtimes.get(revision.runtime);
      yield* invokeExecutable({
        getDefinition: (resource) => repository.getExecutable(resource),
        getRevision: (selected) => repository.getExecutableRevision(selected),
        // The selected repository plane already authorized invocation. The admin plane is unrestricted.
        authorize: async (resource) => {
          repository.requireLiveResource(resource);
          return { lineage: getAuthorizedLineage(input) };
        },
        runtimes: repository.runtimes,
        validator: repository.validator,
        runtimeLimits: (runtime) => structuredClone(repository.runtimeLimits(runtime)),
        secrets: repository.secrets,
        credentials: repository.synchronizedCredentials(),
        recordInvocation: (record) => repository.recordInvocation(record),
      }, id, input);
    })();
  }

  async createGrant(input: CreateGrantInput) {
    const id = grantId(randomUUID());
    return this.commit((state) => ({
      state: addGrant(state, input, id, now()),
      pick: (committed) => committed.grants[id],
    }));
  }

  async setCapabilities(id: GrantId, capabilities: Capability[]) {
    return this.commit((state) => ({
      state: amendCapabilities(state, id, capabilities, now()),
      pick: (committed) => committed.grants[id],
    }));
  }

  async issueToken(id: GrantId, label: string) {
    const value = tokenValue(`rgap_${randomUUID().replaceAll('-', '')}`);
    const tokenRecordId = tokenId(randomUUID());
    const record = this.commit((state) => {
      const token: Token = {
        id: tokenRecordId,
        grantId: id,
        label: label.trim() || 'unnamed token',
        hash: digest(value),
        expiresAt: state.grants[id]?.expiresAt ?? null,
        revokedAt: null,
      };
      return { state: recordToken(state, token, now()), pick: (committed) => committed.tokens[tokenRecordId] };
    });
    return { record, value };
  }

  async revokeToken(id: TokenId) {
    this.commit((state) => ({ state: revokeTokenRecord(state, id, now()), pick: () => undefined }));
  }

  async revokeGrant(id: GrantId) {
    this.commit((state) => ({ state: revokeGrantBranch(state, id, now()), pick: () => undefined }));
  }

  async authorize(token: TokenValue, id: ResourceId, permission: Permission) {
    const at = now();
    return this.commit((state) => {
      const decision = decide(state, digest(token), id, permission, at);
      const next = structuredClone(state);
      next.audit.unshift({
        id: randomUUID(),
        at,
        action: 'authorize',
        target: id,
        result: decision.allowed ? 'allowed' : 'denied',
        detail: decision.detail,
      });
      return { state: next, pick: () => decision };
    });
  }

  async inspectToken(token: TokenValue) {
    return inspectAuthority(this.read(), digest(token), now());
  }

  async reset() {
    const state = this.read();
    await Promise.allSettled([
      ...Object.values(state.secretMetadata).map(({ resourceId }) => this.secrets.delete(resourceId)),
      ...Object.values(state.runtimePrivateMetadata)
        .map(({ runtime, resourceId }) => this.credentials.delete(runtime, resourceId)),
    ]);
    this.commit(() => ({ state: structuredClone(this.initialState), pick: () => undefined }));
  }

  /** Releases the connection. A `:memory:` database ceases to exist with it. */
  close() {
    this.connection.close();
  }

  private requireLiveResource(id: ResourceId) {
    const resource = this.read().resources[id];
    if (!resource || resource.deletedAt) throw new RgapError('missing_resource', 'Resource does not exist.');
  }

  /**
   * Runtime code receives this synchronized facade through core's slot-scoped view, never either
   * backing store. External mutation completes before its public metadata is committed.
   */
  private synchronizedCredentials(): RuntimeCredentialStore {
    return {
      metadata: (runtime, id) => this.getRuntimePrivateMetadata(runtime, id),
      handle: (runtime, id) => this.credentials.handle(runtime, id),
      write: async (runtime, id, value) => {
        this.requireLiveResource(id);
        const metadata = await this.credentials.write(runtime, id, value);
        if (metadata.runtime !== runtime || metadata.resourceId !== id) {
          throw new RgapError(
            'invalid_runtime_metadata',
            'Runtime credential store returned metadata for another runtime or resource.',
          );
        }
        return this.commit((state) => ({
          state: recordRuntimePrivateMetadata(state, metadata),
          pick: (committed) => committed.runtimePrivateMetadata[runtimeMetadataKey(runtime, id)],
        }));
      },
      delete: async (runtime, id) => {
        this.requireLiveResource(id);
        await this.credentials.delete(runtime, id);
        this.commit((state) => {
          const next = structuredClone(state);
          delete next.runtimePrivateMetadata[runtimeMetadataKey(runtime, id)];
          return { state: next, pick: () => undefined };
        });
      },
    };
  }

  private async recordInvocation(record: InvocationRecord) {
    this.commit((state) => {
      const next = structuredClone(state);
      next.audit.unshift({
        id: randomUUID(),
        at: record.finishedAt,
        action: 'executable.invoke',
        target: record.resourceId,
        result: 'recorded',
        detail: JSON.stringify({
          revisionId: record.revisionId,
          runtime: record.runtime,
          grantLineageIds: record.grantLineage,
          bindingResourceIds: Object.values(record.bindings),
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          result: record.result,
        }),
      });
      return { state: next, pick: () => undefined };
    });
  }

  private grantRecord(row: typeof schema.grants.$inferSelect) {
    const permissionRows = this.db.select().from(schema.capabilityPermissions)
      .where(eq(schema.capabilityPermissions.grantId, row.id)).all();
    const held = new Map<number, Set<Permission>>();
    permissionRows.forEach(({ position, permission }) => {
      const set = held.get(position) ?? new Set<Permission>();
      set.add(permission);
      held.set(position, set);
    });
    const capabilities: Capability[] = this.db.select().from(schema.capabilities)
      .where(eq(schema.capabilities.grantId, row.id))
      .orderBy(asc(schema.capabilities.position)).all()
      .map((entry) => {
        const permissions = canonicalPermissions.filter((permission) => held.get(entry.position)?.has(permission));
        return entry.path !== null
          ? { path: entry.path, permissions }
          : { resourceId: resourceId(entry.resourceId!), permissions };
      });
    return {
      id: grantId(row.id),
      name: row.name,
      parentId: row.parentId ? grantId(row.parentId) : null,
      capabilities,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
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
        id: resourceId(row.id),
        parentId: row.parentId ? resourceId(row.parentId) : null,
        name: row.name,
        deletedAt: row.deletedAt,
      };
    });

    this.db.select().from(schema.grants).orderBy(asc(schema.grants.id)).all().forEach((row) => {
      state.grants[row.id] = {
        id: grantId(row.id),
        name: row.name,
        parentId: row.parentId ? grantId(row.parentId) : null,
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
        // An entry's permissions are a set, so they are read in the protocol's canonical order.
        const permissions = canonicalPermissions.filter((permission) => carried?.has(permission));
        state.grants[row.grantId].capabilities.push(
          row.path !== null
            ? { path: row.path, permissions }
            : { resourceId: resourceId(row.resourceId!), permissions },
        );
      });

    this.db.select().from(schema.tokens).orderBy(asc(schema.tokens.id)).all().forEach((row) => {
      state.tokens[row.id] = {
        id: tokenId(row.id),
        grantId: grantId(row.grantId),
        label: row.label,
        hash: tokenHash(row.hash),
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      };
    });

    this.db.select().from(schema.executableRevisions)
      .orderBy(asc(schema.executableRevisions.id)).all().forEach((row) => {
        state.executableRevisions[row.id] = executableRevisionRecord(row);
      });

    this.db.select().from(schema.executables).orderBy(asc(schema.executables.resourceId)).all().forEach((row) => {
      state.executables[row.resourceId] = {
        resourceId: resourceId(row.resourceId),
        activeRevisionId: row.activeRevisionId ? executableRevisionId(row.activeRevisionId) : null,
        deletedAt: row.deletedAt,
      };
    });

    this.db.select().from(schema.secretMetadata).orderBy(asc(schema.secretMetadata.resourceId)).all().forEach((row) => {
      state.secretMetadata[row.resourceId] = {
        resourceId: resourceId(row.resourceId),
        version: row.version,
        updatedAt: row.updatedAt,
      };
    });

    this.db.select().from(schema.runtimePrivateMetadata)
      .orderBy(asc(schema.runtimePrivateMetadata.runtime), asc(schema.runtimePrivateMetadata.resourceId))
      .all().forEach((row) => {
        const metadata = {
          runtime: row.runtime,
          resourceId: resourceId(row.resourceId),
          version: row.version,
          updatedAt: row.updatedAt,
        };
        state.runtimePrivateMetadata[runtimeMetadataKey(metadata.runtime, metadata.resourceId)] = metadata;
      });

    this.db.select().from(schema.audit).orderBy(asc(schema.audit.seq)).all().forEach((row) => {
      state.audit.push({
        id: row.id,
        at: row.at,
        action: row.action,
        target: row.target as RecordId,
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
    this.db.delete(schema.executables).run();
    this.db.delete(schema.executableRevisions).run();
    this.db.delete(schema.secretMetadata).run();
    this.db.delete(schema.runtimePrivateMetadata).run();
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

    const entries: (typeof schema.capabilities)['$inferInsert'][] = [];
    const carried: (typeof schema.capabilityPermissions)['$inferInsert'][] = [];
    Object.values(state.grants).forEach((grant) => {
      grant.capabilities.forEach((capability, position) => {
        entries.push({
          grantId: grant.id,
          position,
          resourceId: isPathCapability(capability) ? null : capability.resourceId,
          path: isPathCapability(capability) ? capability.path : null,
        });
        capability.permissions.forEach((permission) => {
          carried.push({ grantId: grant.id, position, permission });
        });
      });
    });
    insert(this.db, schema.capabilities, entries);
    insert(this.db, schema.capabilityPermissions, carried);

    insert(this.db, schema.tokens, Object.values(state.tokens));
    insert(this.db, schema.executableRevisions, Object.values(state.executableRevisions).map((revision) => ({
      id: revision.id,
      resourceId: revision.resourceId,
      runtime: revision.runtime,
      program: encodeJson(revision.program),
      inputSchema: encodeJson(revision.inputSchema),
      outputSchema: revision.outputSchema === null ? null : encodeJson(revision.outputSchema),
      bindingSchema: encodeJson(revision.bindingSchema),
      limits: encodeJson(revision.limits),
      createdAt: revision.createdAt,
    })));
    insert(this.db, schema.executables, Object.values(state.executables));
    insert(this.db, schema.secretMetadata, Object.values(state.secretMetadata));
    insert(this.db, schema.runtimePrivateMetadata, Object.values(state.runtimePrivateMetadata));
    insert(this.db, schema.audit, state.audit.map((event, seq) => ({ ...event, seq })));
  }

  private isEmpty() {
    return [
      schema.resources, schema.grants, schema.tokens, schema.executables, schema.executableRevisions,
      schema.secretMetadata, schema.runtimePrivateMetadata, schema.audit,
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
  executableRevisions: {},
  secretMetadata: {},
  runtimePrivateMetadata: {},
  audit: [],
});
const completeState = (state?: State): State => ({
  ...emptyState(),
  ...structuredClone(state ?? {}),
});
const now = () => new Date().toISOString();
const entryKey = (grantId: string, position: number) => `${grantId}:${position}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: string) => tokenHash(hash(value));
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
const encodeJson = (value: unknown) => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RgapError('invalid_json', 'Executable values must be JSON-compatible.');
  }
  if (encoded === undefined || !isDeepStrictEqual(value, JSON.parse(encoded))) {
    throw new RgapError('invalid_json', 'Executable values must be JSON-compatible without lossy conversion.');
  }
  return encoded;
};
const executableRevisionRecord = (row: typeof schema.executableRevisions.$inferSelect) => ({
  id: executableRevisionId(row.id),
  resourceId: resourceId(row.resourceId),
  runtime: row.runtime,
  program: JSON.parse(row.program) as unknown,
  inputSchema: JSON.parse(row.inputSchema),
  outputSchema: row.outputSchema === null ? null : JSON.parse(row.outputSchema),
  bindingSchema: JSON.parse(row.bindingSchema),
  limits: JSON.parse(row.limits),
  createdAt: row.createdAt,
});

const unavailable = (service: string): never => {
  throw new RgapError('service_unavailable', `${service} is not configured.`);
};
const unavailableValidator: JsonSchemaValidator = {
  validate: () => unavailable('JSON Schema validator'),
};
const unavailableSecrets: SecretStore = {
  write: async () => unavailable('Secret store'),
  delete: async () => unavailable('Secret store'),
  handle: async () => unavailable('Secret store'),
};
const unavailableCredentials: RuntimeCredentialStore = {
  metadata: async () => undefined,
  handle: async () => unavailable('Runtime credential store'),
  write: async () => unavailable('Runtime credential store'),
  delete: async () => unavailable('Runtime credential store'),
};

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
