import { createFileRoute } from '@tanstack/react-router'
import { CreateConnectionInputSchema } from '../../shared/connections'
import { requireSession } from '../../server/auth'
import { assertTrustedOrigin, jsonError } from '../../server/http'
import { gatewayRuntime } from '../../server/runtime'

export const Route = createFileRoute('/api/connections')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await requireSession(request.headers)
          const connections = await gatewayRuntime.service.list(
            session.user.id,
          )
          return Response.json({ connections })
        } catch (error) {
          return jsonError(error)
        }
      },
      POST: async ({ request }) => {
        try {
          assertTrustedOrigin(request)
          const session = await requireSession(request.headers)
          const input = CreateConnectionInputSchema.parse(
            await request.json(),
          )
          const connection = await gatewayRuntime.service.create(
            session.user.id,
            input,
          )
          return Response.json(connection, { status: 201 })
        } catch (error) {
          return jsonError(error)
        }
      },
    },
  },
})
