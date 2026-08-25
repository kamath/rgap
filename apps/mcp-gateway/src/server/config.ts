import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dataDirectory = resolve(
  process.env.MCP_GATEWAY_DATA_DIRECTORY ?? 'apps/mcp-gateway/.data',
)

mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })

export const appUrl = new URL(
  process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3004',
)

export function dataPath(name: string) {
  return resolve(dataDirectory, name)
}

export function authSecret() {
  const configured = process.env.BETTER_AUTH_SECRET
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET is required in production.')
  }
  return 'local-development-secret-change-before-deployment'
}

export function bearerEncryptionKey() {
  const configured = process.env.GATEWAY_BEARER_ENCRYPTION_KEY
  if (configured) {
    const key = Buffer.from(configured, 'base64')
    if (key.length !== 32) {
      throw new Error(
        'GATEWAY_BEARER_ENCRYPTION_KEY must be a base64-encoded 32-byte key.',
      )
    }
    return key
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'GATEWAY_BEARER_ENCRYPTION_KEY is required in production.',
    )
  }
  return createHash('sha256').update(authSecret()).digest()
}
