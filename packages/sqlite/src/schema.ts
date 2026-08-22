import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AuditEvent, Permission } from '@rgap/core';

/** A resource's stable ID is its key; its parent is a reference to another row of the same table. */
export const resources = sqliteTable('resources', {
  id: text('id').primaryKey(),
  parentId: text('parent_id').references((): AnySQLiteColumn => resources.id),
  name: text('name').notNull(),
  deletedAt: text('deleted_at'),
});

export const grants = sqliteTable('grants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnySQLiteColumn => grants.id),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
});

/** A capability entry has no ID of its own, so it is keyed by its grant and its position in that grant's set. */
export const capabilities = sqliteTable(
  'capabilities',
  {
    grantId: text('grant_id').notNull().references(() => grants.id),
    position: integer('position').notNull(),
    resourceId: text('resource_id').references(() => resources.id),
    path: text('path'),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.position] }),
    check(
      'capabilities_target_check',
      sql`(${table.resourceId} is not null and ${table.path} is null)
        or (${table.resourceId} is null and ${table.path} is not null)`,
    ),
  ],
);

/** One row per permission an entry carries, so a permission set is a relation rather than an encoded value. */
export const capabilityPermissions = sqliteTable(
  'capability_permissions',
  {
    grantId: text('grant_id').notNull(),
    position: integer('position').notNull(),
    permission: text('permission').$type<Permission>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.position, table.permission] }),
    foreignKey({
      columns: [table.grantId, table.position],
      foreignColumns: [capabilities.grantId, capabilities.position],
    }),
  ],
);

export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  grantId: text('grant_id').notNull().references(() => grants.id),
  label: text('label').notNull(),
  hash: text('hash').notNull(),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
});

/** Immutable executable payloads are JSON text; their identity and resource relationship stay relational. */
export const executableRevisions = sqliteTable('executable_revisions', {
  id: text('id').primaryKey(),
  resourceId: text('resource_id').notNull().references(() => resources.id),
  runtime: text('runtime').notNull(),
  program: text('program').notNull(),
  inputSchema: text('input_schema').notNull(),
  outputSchema: text('output_schema'),
  bindingSchema: text('binding_schema').notNull(),
  limits: text('limits').notNull(),
  createdAt: text('created_at').notNull(),
});

export const executables = sqliteTable('executables', {
  resourceId: text('resource_id').primaryKey().references(() => resources.id),
  activeRevisionId: text('active_revision_id').references(() => executableRevisions.id),
  deletedAt: text('deleted_at'),
});

/** Only public metadata is persisted; secret and runtime-private values never enter SQLite. */
export const secretMetadata = sqliteTable('secret_metadata', {
  resourceId: text('resource_id').primaryKey().references(() => resources.id),
  version: text('version').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runtimePrivateMetadata = sqliteTable(
  'runtime_private_metadata',
  {
    runtime: text('runtime').notNull(),
    resourceId: text('resource_id').notNull().references(() => resources.id),
    version: text('version').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.runtime, table.resourceId] })],
);

/** The log's order is stored rather than inferred, so a read returns the events in the order they were recorded. */
export const audit = sqliteTable('audit', {
  seq: integer('seq').primaryKey(),
  id: text('id').notNull().unique(),
  at: text('at').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  result: text('result').$type<AuditEvent['result']>().notNull(),
  detail: text('detail').notNull(),
});
