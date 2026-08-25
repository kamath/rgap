import { afterEach, describe, expect, it } from 'vitest'
import {
  GatewayConnectionStore,
  type GatewayConnection,
} from './connection-store'

const stores: GatewayConnectionStore[] = []

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
})

describe('GatewayConnectionStore', () => {
  it('scopes every public lookup to the Better Auth user', () => {
    const store = createStore()
    store.create(connection())

    expect(store.get('cn_test', 'user-a')?.resourceId).toBe('resource-secret')
    expect(
      store.getByCredentialId('credential-secret')?.userId,
    ).toBe('user-a')
    expect(store.get('cn_test', 'user-b')).toBeUndefined()
    expect(store.list('user-b')).toEqual([])
  })

  it('updates public status without changing private identifiers', () => {
    const store = createStore()
    store.create(connection())

    const updated = store.updateStatus(
      'cn_test',
      'user-a',
      'authorization_required',
      'https://auth.example.com',
    )

    expect(updated).toMatchObject({
      status: 'authorization_required',
      authorizationUrl: 'https://auth.example.com',
      resourceId: 'resource-secret',
    })
  })

  it('does not let another user delete a connection', () => {
    const store = createStore()
    store.create(connection())

    expect(store.delete('cn_test', 'user-b')).toBeUndefined()
    expect(store.get('cn_test', 'user-a')).toBeDefined()
  })
})

function createStore() {
  const store = new GatewayConnectionStore(':memory:')
  stores.push(store)
  return store
}

function connection(): GatewayConnection {
  return {
    id: 'cn_test',
    userId: 'user-a',
    displayName: 'Test',
    serverUrl: 'https://mcp.example.com/',
    status: 'connected',
    resourceId: 'resource-secret',
    credentialResourceId: 'credential-secret',
    grantId: 'grant-secret',
    encryptedRgapBearer: 'encrypted-secret',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  }
}
