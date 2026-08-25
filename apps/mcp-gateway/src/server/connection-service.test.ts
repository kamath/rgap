import { randomBytes } from 'node:crypto'
import { tokenValue } from '@rgap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BearerVault } from './bearer-vault'
import { ConnectionService } from './connection-service'
import {
  GatewayConnectionStore,
  type GatewayConnection,
} from './connection-store'

const stores: GatewayConnectionStore[] = []

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
})

describe('ConnectionService dispatch', () => {
  it('lists and reads stored status without reconnecting upstream', async () => {
    const { service, mcp } = setup()

    await expect(service.list('user-a')).resolves.toHaveLength(1)
    await expect(service.get('cn_test', 'user-a')).resolves.toMatchObject({
      status: 'connected',
    })
    expect(mcp.connect).not.toHaveBeenCalled()
  })

  it('swaps the Better Auth credential for the private RGAP bearer', async () => {
    const { service, connections } = setup()
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/mcp/rgap-resource-id')
      expect(request.headers.get('authorization')).toBe(
        'Bearer rgap_private_secret',
      )
      expect(request.headers.get('cookie')).toBeNull()
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    })

    const response = await service.dispatch(
      new Request('https://gateway.example/mcp/cn_test', {
        method: 'POST',
        headers: {
          authorization: 'Bearer better-auth-session',
          cookie: 'better-auth.session=public',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      }),
      'cn_test',
      'user-a',
      { fetch },
    )

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
    connections.close()
    stores.splice(stores.indexOf(connections), 1)
  })

  it('does not dispatch another user’s public connection ID', async () => {
    const { service } = setup()

    await expect(
      service.dispatch(
        new Request('https://gateway.example/mcp/cn_test', {
          method: 'POST',
          body: '{}',
        }),
        'cn_test',
        'user-b',
        { fetch: vi.fn() },
      ),
    ).rejects.toMatchObject({ status: 404 })
  })
})

function setup() {
  const connections = new GatewayConnectionStore(':memory:')
  stores.push(connections)
  const vault = new BearerVault(randomBytes(32))
  const record: GatewayConnection = {
    id: 'cn_test',
    userId: 'user-a',
    displayName: 'Test',
    serverUrl: 'https://mcp.example.com/',
    status: 'connected',
    resourceId: 'rgap-resource-id',
    credentialResourceId: 'credential-id',
    grantId: 'grant-id',
    encryptedRgapBearer: vault.encrypt(tokenValue('rgap_private_secret')),
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  }
  connections.create(record)
  const mcp = {
    connect: vi.fn(),
  }
  const service = new ConnectionService({
    store: {} as never,
    mcp: mcp as never,
    credentialStore: {} as never,
    connections,
    bearerVault: vault,
  })
  return { service, connections, mcp }
}
