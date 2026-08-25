import { ZodError } from 'zod'
import { appUrl } from './config'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

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
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error('MCP gateway request failed.', error)
  return Response.json(
    { error: 'Request failed.' },
    { status: 500 },
  )
}
