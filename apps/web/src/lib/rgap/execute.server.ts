import {
  RgapError,
  rgapErrorResponseSchema,
  rgapRequestSchema,
  rgapSuccessResponseSchema,
  type RgapEngine,
  type RgapRequest,
  type RgapResponse,
} from '@rgap/core'
import { ZodError } from 'zod'

import { getDatabase } from '../../db/client.server'
import { DrizzleRgapEngine } from './drizzle-engine.server'

export async function executeRgapRequest(
  request: RgapRequest,
  engine?: RgapEngine,
): Promise<RgapResponse> {
  const parsed = rgapRequestSchema.parse(request)
  const rgap = engine ?? new DrizzleRgapEngine(await getDatabase())

  let result: unknown
  switch (parsed.method) {
    case 'resource.create': result = await rgap.createResource(parsed.params); break
    case 'resource.move': result = await rgap.moveResource(parsed.params); break
    case 'grant.create': result = await rgap.createGrant(parsed.params); break
    case 'grant.delegate': result = await rgap.delegate(parsed.params); break
    case 'token.issue': result = await rgap.issueToken(parsed.params); break
    case 'authorize': result = await rgap.authorize(parsed.params); break
    case 'token.revoke': result = await rgap.revokeToken(parsed.params); break
    case 'grant.revoke': result = await rgap.revokeGrant(parsed.params); break
  }

  return rgapSuccessResponseSchema.parse({ id: parsed.id, result })
}

export function rgapErrorResponse(error: unknown, id: string | number | null) {
  if (error instanceof RgapError) {
    return rgapErrorResponseSchema.parse({ id, error: error.toJSON() })
  }
  if (error instanceof ZodError) {
    return rgapErrorResponseSchema.parse({
      id,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: error.issues },
      },
    })
  }

  console.error(error)
  return rgapErrorResponseSchema.parse({
    id,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed',
      details: {},
    },
  })
}
