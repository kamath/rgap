import { z } from '@hono/zod-openapi';
import { permissions } from '@rgap/core';

export const IdSchema = z.string().min(1);
export const NullableIdSchema = IdSchema.nullable();
export const TimestampSchema = z.iso.datetime();
export const NullableTimestampSchema = TimestampSchema.nullable();
export const PermissionSchema = z.enum(permissions);

export const ResourceSchema = z.object({
  id: IdSchema,
  parentId: NullableIdSchema,
  name: z.string(),
  deletedAt: NullableTimestampSchema,
}).openapi('Resource');

export const JsonValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
const ExecutableInputSchema = z.record(z.string(), z.unknown());

export const ExecutableDefinitionSchema = z.object({
  resourceId: IdSchema,
  runtime: z.string(),
  input: ExecutableInputSchema,
  bind: z.record(z.string(), z.object({
    resourceId: IdSchema,
    grantLineage: z.array(IdSchema).nullable(),
  }).strict()),
}).openapi('ExecutableDefinition');

export const SetExecutableSchema = z.object({
  runtime: z.string().min(1),
  input: ExecutableInputSchema.optional(),
  bind: z.record(z.string(), IdSchema).optional(),
}).strict();

export const InvokeSchema = z.object({
  input: JsonValueSchema,
}).strict();

export const InvocationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), value: JsonValueSchema }).strict(),
  z.object({ type: z.literal('done') }).strict(),
]).openapi('InvocationEvent');

export const GrantResourceSchema = z.object({
  id: IdSchema,
  permissions: z.array(PermissionSchema),
}).strict().openapi('GrantResource');

export const GrantSchema = z.object({
  id: IdSchema,
  name: z.string(),
  parentId: NullableIdSchema,
  resources: z.array(GrantResourceSchema),
  expiresAt: NullableTimestampSchema,
  revokedAt: NullableTimestampSchema,
}).openapi('Grant');

export const TokenSchema = z.object({
  id: IdSchema,
  grantId: IdSchema,
  label: z.string(),
  hash: z.string(),
  expiresAt: NullableTimestampSchema,
  revokedAt: NullableTimestampSchema,
}).openapi('Token');

export const AuditEventSchema = z.object({
  id: IdSchema,
  at: TimestampSchema,
  action: z.string(),
  target: IdSchema,
  result: z.enum(['allowed', 'denied', 'recorded']),
  detail: z.string(),
}).openapi('AuditEvent');

export const DecisionSchema = z.object({
  allowed: z.boolean(),
  detail: z.string(),
  grantId: NullableIdSchema,
  lineage: z.array(IdSchema),
}).openapi('Decision');

export const IssuedTokenSchema = z.object({
  record: TokenSchema,
  value: z.string(),
}).openapi('IssuedToken');

export const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
}).openapi('ApiError');

export const AuthorizationHeaderSchema = z.object({
  authorization: z.string().regex(/^Bearer \S+$/),
});

export const IdParamsSchema = z.object({
  id: IdSchema.openapi({ param: { name: 'id', in: 'path' } }),
});

export const PageQuerySchema = z.object({
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const NullableParentQuerySchema = z.preprocess(
  (value) => value === '' || value === 'null' ? null : value,
  NullableIdSchema.optional(),
);

export const ResourceListQuerySchema = PageQuerySchema.extend({
  parentId: NullableParentQuerySchema,
});

export const GrantListQuerySchema = PageQuerySchema.extend({
  parentId: NullableParentQuerySchema,
});

export const TokenListQuerySchema = PageQuerySchema.extend({
  grantId: IdSchema.optional(),
});

export const ResourceWriteSchema = z.object({
  name: z.string().min(1),
  executable: SetExecutableSchema.optional(),
}).strict();

export const MoveResourceSchema = z.object({
  parentId: NullableIdSchema,
}).strict();

export const GrantWriteSchema = z.object({
  name: z.string().min(1),
  resources: z.array(GrantResourceSchema),
  expiresAt: NullableTimestampSchema,
}).strict();

export const SetResourcesSchema = z.object({
  resources: z.array(GrantResourceSchema),
}).strict();

export const TokenWriteSchema = z.object({
  label: z.string(),
}).strict();

export const AuthorizeSchema = z.object({
  token: z.string().min(1),
  resourceId: IdSchema,
  permission: PermissionSchema,
}).strict();
