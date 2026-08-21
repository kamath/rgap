import * as z from 'zod'

export const identifierSchema = z.string().trim().min(1).max(255)
export const timestampSchema = z.iso.datetime({ offset: true })
export const jsonValueSchema = z.json()
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

export const movePolicySchema = z.enum(['normal', 'deny_while_granted'])
export const deletePolicySchema = z.enum(['revoke', 'deny_while_granted'])
export const descendantPolicySchema = z.enum(['exclude', 'include'])
export const relocationPolicySchema = z.enum([
  'follow_resource',
  'revoke_on_scope_exit',
  'deny_move',
])

const permissionListSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .refine((items) => new Set(items).size === items.length, {
    error: 'permissions must be unique',
  })

export const capabilitySchema = z.strictObject({
  resource_id: identifierSchema,
  permissions: permissionListSchema,
  constraints: jsonObjectSchema.default({}),
  descendant_policy: descendantPolicySchema.default('exclude'),
  relocation_policy: relocationPolicySchema.default('revoke_on_scope_exit'),
})

export const resourceSchema = z.strictObject({
  id: identifierSchema,
  parent_resource_id: identifierSchema.nullable(),
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(100),
  move_policy: movePolicySchema,
  delete_policy: deletePolicySchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
})

export const grantSchema = z.strictObject({
  id: identifierSchema,
  parent_grant_id: identifierSchema.nullable(),
  capabilities: z.array(capabilitySchema).min(1),
  expires_at: timestampSchema.nullable(),
  revoked_at: timestampSchema.nullable(),
  created_by: identifierSchema.nullable(),
  created_at: timestampSchema,
})

export const tokenRecordSchema = z.strictObject({
  id: identifierSchema,
  grant_id: identifierSchema,
  token_prefix: z.string().min(4).max(32),
  expires_at: timestampSchema.nullable(),
  revoked_at: timestampSchema.nullable(),
  created_at: timestampSchema,
})

export const auditEventSchema = z.strictObject({
  id: identifierSchema,
  actor: identifierSchema.nullable(),
  action: z.string().min(1),
  target: identifierSchema.nullable(),
  decision: z.enum(['allow', 'deny']).nullable(),
  metadata: jsonObjectSchema.default({}),
  created_at: timestampSchema,
})

export const createResourceInputSchema = z.strictObject({
  id: identifierSchema.optional(),
  parent_resource_id: identifierSchema.nullable().default(null),
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(100),
  move_policy: movePolicySchema.default('normal'),
  delete_policy: deletePolicySchema.default('revoke'),
})
export const createResourceOutputSchema = resourceSchema

export const moveResourceInputSchema = z.strictObject({
  resource_id: identifierSchema,
  new_parent_resource_id: identifierSchema.nullable(),
  actor: identifierSchema.nullable().default(null),
})
export const moveResourceOutputSchema = resourceSchema

export const createGrantInputSchema = z.strictObject({
  id: identifierSchema.optional(),
  capabilities: z.array(capabilitySchema).min(1),
  expires_at: timestampSchema.nullable().default(null),
  created_by: identifierSchema.nullable().default(null),
})
export const createGrantOutputSchema = grantSchema

export const delegateGrantInputSchema = z.strictObject({
  id: identifierSchema.optional(),
  parent_grant_id: identifierSchema,
  capabilities: z.array(capabilitySchema).min(1),
  expires_at: timestampSchema.nullable().default(null),
  created_by: identifierSchema.nullable().default(null),
})
export const delegateGrantOutputSchema = grantSchema

export const issueTokenInputSchema = z.strictObject({
  id: identifierSchema.optional(),
  grant_id: identifierSchema,
  expires_at: timestampSchema.nullable().default(null),
  actor: identifierSchema.nullable().default(null),
})

export const issuedTokenSchema = z.strictObject({
  token: z.string().min(32),
  token_record: tokenRecordSchema,
})
export const issueTokenOutputSchema = issuedTokenSchema

export const authorizationRequestSchema = z.strictObject({
  token: z.string().min(1),
  resource_id: identifierSchema,
  permission: z.string().trim().min(1),
  constraints: jsonObjectSchema.default({}),
})

export const authorizationReasonSchema = z.enum([
  'allowed',
  'token_invalid',
  'token_revoked',
  'token_expired',
  'grant_revoked',
  'grant_expired',
  'ancestor_revoked',
  'ancestor_expired',
  'resource_not_found',
  'capability_not_found',
  'permission_denied',
  'constraints_not_satisfied',
])

export const authorizationDecisionSchema = z.strictObject({
  allowed: z.boolean(),
  reason: authorizationReasonSchema,
  grant_id: identifierSchema.nullable(),
  matched_capability: capabilitySchema.nullable(),
  grant_lineage: z.array(identifierSchema),
  evaluated_at: timestampSchema,
})
export const authorizeOutputSchema = authorizationDecisionSchema

export const revokeTokenInputSchema = z.strictObject({
  token_id: identifierSchema,
  actor: identifierSchema.nullable().default(null),
})
export const revokeTokenOutputSchema = z.strictObject({
  token_id: identifierSchema,
  revoked: z.literal(true),
  revoked_at: timestampSchema,
})

export const revokeGrantInputSchema = z.strictObject({
  grant_id: identifierSchema,
  actor: identifierSchema.nullable().default(null),
})
export const revokeGrantOutputSchema = z.strictObject({
  grant_id: identifierSchema,
  revoked: z.literal(true),
  revoked_at: timestampSchema,
})

export const rgapErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'AUTHORITY_EXPANSION',
  'REVOKED',
  'EXPIRED',
  'MOVE_DENIED',
  'INTERNAL_ERROR',
])

export const rgapErrorSchema = z.strictObject({
  code: rgapErrorCodeSchema,
  message: z.string().min(1),
  details: jsonObjectSchema.default({}),
})

const requestIdSchema = z.union([z.string().min(1), z.number().int()])

export const rgapRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('resource.create'),
    params: createResourceInputSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('resource.move'),
    params: moveResourceInputSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('grant.create'),
    params: createGrantInputSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('grant.delegate'),
    params: delegateGrantInputSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('token.issue'),
    params: issueTokenInputSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('authorize'),
    params: authorizationRequestSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('token.revoke'),
    params: revokeTokenInputSchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    method: z.literal('grant.revoke'),
    params: revokeGrantInputSchema,
  }),
])

export const rgapSuccessResponseSchema = z.strictObject({
  id: requestIdSchema,
  result: jsonValueSchema,
})
export const rgapErrorResponseSchema = z.strictObject({
  id: requestIdSchema.nullable(),
  error: rgapErrorSchema,
})
export const rgapResponseSchema = z.union([
  rgapSuccessResponseSchema,
  rgapErrorResponseSchema,
])

export const rgapMethodSchemas = {
  'resource.create': {
    input: createResourceInputSchema,
    output: createResourceOutputSchema,
  },
  'resource.move': {
    input: moveResourceInputSchema,
    output: moveResourceOutputSchema,
  },
  'grant.create': {
    input: createGrantInputSchema,
    output: createGrantOutputSchema,
  },
  'grant.delegate': {
    input: delegateGrantInputSchema,
    output: delegateGrantOutputSchema,
  },
  'token.issue': {
    input: issueTokenInputSchema,
    output: issueTokenOutputSchema,
  },
  authorize: {
    input: authorizationRequestSchema,
    output: authorizeOutputSchema,
  },
  'token.revoke': {
    input: revokeTokenInputSchema,
    output: revokeTokenOutputSchema,
  },
  'grant.revoke': {
    input: revokeGrantInputSchema,
    output: revokeGrantOutputSchema,
  },
} as const

export type JsonValue = z.infer<typeof jsonValueSchema>
export type JsonObject = z.infer<typeof jsonObjectSchema>
export type Capability = z.output<typeof capabilitySchema>
export type Resource = z.output<typeof resourceSchema>
export type Grant = z.output<typeof grantSchema>
export type TokenRecord = z.output<typeof tokenRecordSchema>
export type AuditEvent = z.output<typeof auditEventSchema>

export type CreateResourceInput = z.input<typeof createResourceInputSchema>
export type MoveResourceInput = z.input<typeof moveResourceInputSchema>
export type CreateGrantInput = z.input<typeof createGrantInputSchema>
export type DelegateGrantInput = z.input<typeof delegateGrantInputSchema>
export type IssueTokenInput = z.input<typeof issueTokenInputSchema>
export type AuthorizationRequest = z.input<typeof authorizationRequestSchema>
export type RevokeTokenInput = z.input<typeof revokeTokenInputSchema>
export type RevokeGrantInput = z.input<typeof revokeGrantInputSchema>

export type IssuedToken = z.output<typeof issuedTokenSchema>
export type AuthorizationDecision = z.output<
  typeof authorizationDecisionSchema
>
export type RevokeTokenOutput = z.output<typeof revokeTokenOutputSchema>
export type RevokeGrantOutput = z.output<typeof revokeGrantOutputSchema>
export type RgapRequest = z.output<typeof rgapRequestSchema>
export type RgapResponse = z.output<typeof rgapResponseSchema>
export type RgapErrorCode = z.output<typeof rgapErrorCodeSchema>
export type RgapErrorShape = z.output<typeof rgapErrorSchema>
