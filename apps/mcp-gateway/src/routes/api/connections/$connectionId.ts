import { createFileRoute } from '@tanstack/react-router'
import { requireSession } from '../../../server/auth'
import { assertTrustedOrigin, jsonError } from '../../../server/http'
import { gatewayRuntime } from '../../../server/runtime'

export const Route = createFileRoute('/api/connections/$connectionId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const session = await requireSession(request.headers)
          const connection = await gatewayRuntime.service.get(
            params.connectionId,
            session.user.id,
          )
          if (!connection) {
            return Response.json(
              { error: 'Connection not found.' },
              { status: 404 },
            )
          }
          return Response.json(connection)
        } catch (error) {
          return jsonError(error)
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          assertTrustedOrigin(request)
          const session = await requireSession(request.headers)
          const deleted = await gatewayRuntime.service.delete(
            params.connectionId,
            session.user.id,
          )
          return deleted
            ? new Response(null, { status: 204 })
            : Response.json(
                { error: 'Connection not found.' },
                { status: 404 },
              )
        } catch (error) {
          return jsonError(error)
        }
      },
    },
  },
})
