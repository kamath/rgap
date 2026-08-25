import { createFileRoute } from '@tanstack/react-router'
import { auth, ensureAuthReady } from '../../../server/auth'

async function handle(request: Request) {
  await ensureAuthReady()
  return auth.handler(request)
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
