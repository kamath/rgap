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

export const ExecutableDefinitionSchema = z.object({
  resourceId: IdSchema,
  activeRevisionId: NullableIdSchema,
  deletedAt: NullableTimestampSchema,
}).openapi('ExecutableDefinition');

export const JsonValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const JsonSchemaSchema = z.union([
  z.boolean(),
  z.record(z.string(), z.unknown()),
]).openapi('JsonSchema');

export const BindingSlotSchema = z.object({
  kind: z.enum(['resource', 'secret', 'runtime-private']),
  access: z.enum(['use', 'write']),
  required: z.boolean().optional(),
}).strict().openapi('BindingSlot');

export const ExecutionLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  memoryBytes: z.number().int().positive().optional(),
  outputBytes: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  network: z.object({
    allowedOrigins: z.array(z.string()),
  }).strict().optional(),
}).strict().openapi('ExecutionLimits');

export const ExecutableRevisionSchema = z.object({
  id: IdSchema,
  resourceId: IdSchema,
  runtime: z.string(),
  program: JsonValueSchema,
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema.nullable(),
  bindingSchema: z.record(z.string(), BindingSlotSchema),
  limits: ExecutionLimitsSchema,
  createdAt: TimestampSchema,
}).openapi('ExecutableRevision');

export const PublishExecutableSchema = ExecutableRevisionSchema.omit({
  id: true,
  resourceId: true,
  createdAt: true,
}).strict();

export const SecretMetadataSchema = z.object({
  resourceId: IdSchema,
  version: z.string(),
  updatedAt: TimestampSchema,
}).openapi('SecretMetadata');

export const SecretWriteSchema = z.object({
  value: z.string(),
}).strict();

export const RuntimePrivateMetadataSchema = z.object({
  runtime: z.string(),
  resourceId: IdSchema,
  version: z.string(),
  updatedAt: TimestampSchema,
}).openapi('RuntimePrivateMetadata');

export const RuntimeMetadataParamsSchema = z.object({
  id: IdSchema.openapi({ param: { name: 'id', in: 'path' } }),
  runtime: z.string().min(1).openapi({ param: { name: 'runtime', in: 'path' } }),
});

export const InvokeSchema = z.object({
  input: JsonValueSchema,
  bindings: z.record(z.string(), IdSchema).optional(),
  revisionId: IdSchema.optional(),
}).strict();

export const InvocationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), value: JsonValueSchema }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict(),
  z.object({ type: z.literal('done') }).strict(),
]).openapi('InvocationEvent');

const CapabilityConfigSchema = {
  permissions: z.array(PermissionSchema),
};

export const CapabilitySchema = z.union([
  z.object({
    ...CapabilityConfigSchema,
    resourceId: IdSchema,
  }).strict(),
  z.object({
    ...CapabilityConfigSchema,
    path: z.string(),
  }).strict(),
]).openapi('Capability');

export const GrantSchema = z.object({
  id: IdSchema,
  name: z.string(),
  parentId: NullableIdSchema,
  capabilities: z.array(CapabilitySchema),
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

export const AuthorityViewSchema = z.object({
  valid: z.boolean(),
  detail: z.string(),
  grantId: NullableIdSchema,
  lineage: z.array(IdSchema),
  permissions: z.record(z.string(), z.array(PermissionSchema)),
}).openapi('AuthorityView');

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
  parentId: NullableIdSchema,
}).strict();

export const MoveResourceSchema = z.object({
  parentId: NullableIdSchema,
}).strict();

export const GrantWriteSchema = z.object({
  name: z.string().min(1),
  parentId: NullableIdSchema,
  capabilities: z.array(CapabilitySchema),
  expiresAt: NullableTimestampSchema,
}).strict();

export const SetCapabilitiesSchema = z.object({
  capabilities: z.array(CapabilitySchema),
}).strict();

export const TokenWriteSchema = z.object({
  label: z.string(),
}).strict();

export const AuthorizeSchema = z.object({
  token: z.string().min(1),
  resourceId: IdSchema,
  permission: PermissionSchema,
}).strict();

export const InspectTokenSchema = z.object({
  token: z.string().min(1),
}).strict();
