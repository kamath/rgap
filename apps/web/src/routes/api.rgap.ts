import { rgapRequestSchema } from '@rgap/core'
import { createFileRoute } from '@tanstack/react-router'

import { executeRgapRequest, rgapErrorResponse } from '../lib/rgap/execute.server'

export const Route = createFileRoute('/api/rgap')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
          const parsed = rgapRequestSchema.parse(body)
          return Response.json(await executeRgapRequest(parsed))
        } catch (error) {
          const response = rgapErrorResponse(error, extractRequestId(body))
          const status = response.error.code === 'INTERNAL_ERROR' ? 500 : 400
          return Response.json(response, { status })
        }
      },
    },
  },
})

function extractRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object' || !('id' in body)) return null
  const id = body.id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}
