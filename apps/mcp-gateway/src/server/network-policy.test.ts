import { afterEach, describe, expect, it } from 'vitest'
import { assertAllowedServerUrl } from './network-policy'

const originalNodeEnv = process.env.NODE_ENV
const originalPrivateSetting = process.env.ALLOW_PRIVATE_MCP_URLS

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  if (originalPrivateSetting === undefined) {
    delete process.env.ALLOW_PRIVATE_MCP_URLS
  } else {
    process.env.ALLOW_PRIVATE_MCP_URLS = originalPrivateSetting
  }
})

describe.sequential('MCP network policy', () => {
  it('rejects URL credentials', async () => {
    await expect(
      assertAllowedServerUrl('https://user:secret@mcp.example.com'),
    ).rejects.toThrow('cannot contain credentials')
  })

  it('rejects private destinations in production', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.ALLOW_PRIVATE_MCP_URLS

    await expect(
      assertAllowedServerUrl('https://127.0.0.1/mcp'),
    ).rejects.toThrow('private network')
  })

  it('allows explicit loopback development servers', async () => {
    process.env.NODE_ENV = 'development'

    await expect(
      assertAllowedServerUrl('http://127.0.0.1:3100/mcp'),
    ).resolves.toEqual(new URL('http://127.0.0.1:3100/mcp'))
  })
})
