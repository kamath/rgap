import { foreignKey, integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
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

/** A grant resource has no ID of its own, so it is keyed by its grant and its position in that grant's set. */
export const grantResources = sqliteTable(
  'grant_resources',
  {
    grantId: text('grant_id').notNull().references(() => grants.id),
    position: integer('position').notNull(),
    id: text('id').notNull().references(() => resources.id),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.position] }),
  ],
);

/** One row per permission an entry carries, so a permission set is a relation rather than an encoded value. */
export const grantResourcePermissions = sqliteTable(
  'grant_resource_permissions',
  {
    grantId: text('grant_id').notNull(),
    position: integer('position').notNull(),
    permission: text('permission').$type<Permission>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.position, table.permission] }),
    foreignKey({
      columns: [table.grantId, table.position],
      foreignColumns: [grantResources.grantId, grantResources.position],
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

export const executables = sqliteTable('executables', {
  resourceId: text('resource_id').primaryKey().references(() => resources.id),
  runtime: text('runtime').notNull(),
});

export const executableBindings = sqliteTable(
  'executable_bindings',
  {
    executableResourceId: text('executable_resource_id').notNull()
      .references(() => executables.resourceId),
    name: text('name').notNull(),
    resourceId: text('resource_id').notNull().references(() => resources.id),
    /** JSON grant ID array; null denotes administrative provenance. */
    grantLineage: text('grant_lineage'),
  },
  (table) => [
    primaryKey({ columns: [table.executableResourceId, table.name] }),
  ],
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
