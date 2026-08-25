import { z } from 'zod'

export const ConnectionStatusSchema = z.enum([
  'authorization_required',
  'connected',
  'error',
])

export const CreateConnectionInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    serverUrl: z.url({ protocol: /^https?:$/ }),
  })
  .strict()

export const ConnectionSchema = z
  .object({
    id: z.string().startsWith('cn_'),
    displayName: z.string(),
    serverUrl: z.url({ protocol: /^https?:$/ }),
    status: ConnectionStatusSchema,
    authorizationUrl: z.url().optional(),
  })
  .strict()

export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>
export type CreateConnectionInput = z.infer<
  typeof CreateConnectionInputSchema
>
export type Connection = z.infer<typeof ConnectionSchema>
