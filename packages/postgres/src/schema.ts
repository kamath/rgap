import type { AuditEvent, Permission } from '@rgap/core';
import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** A resource's stable ID is its key; its parent is a reference to another row of the same table. */
export const resources = pgTable('resources', {
  id: text('id').primaryKey(),
  parentId: text('parent_id').references((): AnyPgColumn => resources.id),
  name: text('name').notNull(),
  deletedAt: text('deleted_at'),
});

export const grants = pgTable('grants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnyPgColumn => grants.id),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
});

export const grantBindings = pgTable(
  'grant_bindings',
  {
    grantId: text('grant_id').notNull().references(() => grants.id),
    position: integer('position').notNull(),
    id: text('id').notNull().references(() => resources.id),
  },
  (table) => [primaryKey({ columns: [table.grantId, table.position] })],
);

export const grantBindingPermissions = pgTable(
  'grant_binding_permissions',
  {
    grantId: text('grant_id').notNull(),
    position: integer('position').notNull(),
    permission: text('permission').$type<Permission>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.position, table.permission] }),
    foreignKey({
      columns: [table.grantId, table.position],
      foreignColumns: [grantBindings.grantId, grantBindings.position],
    }),
  ],
);

export const tokens = pgTable('tokens', {
  id: text('id').primaryKey(),
  grantId: text('grant_id').notNull().references(() => grants.id),
  label: text('label').notNull(),
  hash: text('hash').notNull(),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
});

export const executables = pgTable('executables', {
  resourceId: text('resource_id').primaryKey().references(() => resources.id),
  runtime: text('runtime').notNull(),
  input: text('input').notNull(),
});

export const executableBindings = pgTable(
  'executable_bindings',
  {
    executableResourceId: text('executable_resource_id').notNull()
      .references(() => executables.resourceId),
    name: text('name').notNull(),
    resourceId: text('resource_id').notNull().references(() => resources.id),
    grantLineage: text('grant_lineage'),
  },
  (table) => [primaryKey({ columns: [table.executableResourceId, table.name] })],
);

/** The log's order is explicit so reads preserve the order in which events are recorded. */
export const audit = pgTable('audit', {
  seq: integer('seq').primaryKey(),
  id: text('id').notNull().unique(),
  at: text('at').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  result: text('result').$type<AuditEvent['result']>().notNull(),
  detail: text('detail').notNull(),
});
