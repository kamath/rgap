import { ZodError } from 'zod'
import { appUrl } from './config'

export function assertTrustedOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== appUrl.origin) {
    throw new Response('Origin is not allowed.', { status: 403 })
  }
}

export function jsonError(error: unknown) {
  if (error instanceof Response) return error
  if (error instanceof ZodError) {
    return Response.json(
      { error: 'Invalid request.', issues: error.issues },
      { status: 400 },
    )
  }
  console.error('MCP gateway request failed.', error)
  return Response.json(
    { error: error instanceof Error ? error.message : 'Request failed.' },
    { status: 400 },
  )
}
