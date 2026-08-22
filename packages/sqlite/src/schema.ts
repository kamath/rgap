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
