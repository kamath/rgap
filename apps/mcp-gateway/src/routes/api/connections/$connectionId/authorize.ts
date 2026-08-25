import { createFileRoute } from '@tanstack/react-router'
import { requireSession } from '../../../../server/auth'
import {
  assertTrustedOrigin,
  jsonError,
} from '../../../../server/http'
import { gatewayRuntime } from '../../../../server/runtime'

export const Route = createFileRoute(
  '/api/connections/$connectionId/authorize',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          assertTrustedOrigin(request)
          const session = await requireSession(request.headers)
          const connection = await gatewayRuntime.service.authorize(
            params.connectionId,
            session.user.id,
          )
          return Response.json(connection)
        } catch (error) {
          return jsonError(error)
        }
      },
    },
  },
})
