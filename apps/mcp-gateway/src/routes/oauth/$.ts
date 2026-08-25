import { createFileRoute } from '@tanstack/react-router'
import { gatewayRuntime } from '../../server/runtime'

export const Route = createFileRoute('/oauth/$')({
  server: {
    handlers: {
      GET: ({ request }) => gatewayRuntime.proxy.fetch(request),
    },
  },
})
