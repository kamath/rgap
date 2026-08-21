import type { JsonObject } from '@rgap/core'
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

const timestamptz = (name: string) =>
  timestamp(name, { mode: 'string', withTimezone: true })

export const resources = pgTable(
  'resources',
  {
    id: text('id').primaryKey(),
    parentResourceId: text('parent_resource_id').references(
      (): AnyPgColumn => resources.id,
    ),
    name: text('name').notNull(),
    type: text('type').notNull(),
    movePolicy: text('move_policy').notNull(),
    deletePolicy: text('delete_policy').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [index('resources_parent_idx').on(table.parentResourceId)],
)

export const grants = pgTable(
  'grants',
  {
    id: text('id').primaryKey(),
    parentGrantId: text('parent_grant_id').references(
      (): AnyPgColumn => grants.id,
    ),
    expiresAt: timestamptz('expires_at'),
    revokedAt: timestamptz('revoked_at'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [index('grants_parent_idx').on(table.parentGrantId)],
)

export const grantCapabilities = pgTable(
  'grant_capabilities',
  {
    grantId: text('grant_id')
      .notNull()
      .references(() => grants.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    permissions: jsonb('permissions').$type<string[]>().notNull(),
    constraints: jsonb('constraints').$type<JsonObject>().notNull(),
    descendantPolicy: text('descendant_policy').notNull(),
    relocationPolicy: text('relocation_policy').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.position] }),
    index('grant_capabilities_resource_idx').on(table.resourceId),
  ],
)

export const tokens = pgTable(
  'tokens',
  {
    id: text('id').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => grants.id),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    expiresAt: timestamptz('expires_at'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [index('tokens_grant_idx').on(table.grantId)],
)

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    actor: text('actor'),
    action: text('action').notNull(),
    target: text('target'),
    decision: text('decision'),
    metadata: jsonb('metadata').$type<JsonObject>().notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    index('audit_events_created_idx').on(table.createdAt),
    index('audit_events_target_idx').on(table.target),
  ],
)

export const rgapSchema = {
  resources,
  grants,
  grantCapabilities,
  tokens,
  auditEvents,
}
