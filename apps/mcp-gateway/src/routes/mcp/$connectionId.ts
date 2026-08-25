import { createFileRoute } from '@tanstack/react-router'
import { requireSession } from '../../server/auth'
import { assertTrustedOrigin, jsonError } from '../../server/http'
import { gatewayRuntime } from '../../server/runtime'

export const Route = createFileRoute('/mcp/$connectionId')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          assertTrustedOrigin(request)
          const session = await requireSession(request.headers)
          return gatewayRuntime.service.dispatch(
            request,
            params.connectionId,
            session.user.id,
            gatewayRuntime.proxy,
          )
        } catch (error) {
          return jsonError(error)
        }
      },
    },
  },
})
