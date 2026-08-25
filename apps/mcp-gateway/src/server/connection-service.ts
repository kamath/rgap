import { createHash, randomUUID } from 'node:crypto'
import {
  grantId,
  resourceId,
  RgapError,
  type ResourceHandle,
  type ResourceId,
  type RgapRepository,
  type RgapStore,
  type SetExecutableInput,
} from '@rgap/core'
import {
  type CredentialStore,
  type McpCredential,
  type McpProxyRuntime,
} from '@rgap/mcp-proxy'
import {
  ConnectionSchema,
  type Connection,
  type CreateConnectionInput,
} from '../shared/connections'
import { BearerVault } from './bearer-vault'
import {
  GatewayConnectionStore,
  type GatewayConnection,
} from './connection-store'
import { assertAllowedServerUrl } from './network-policy'

type ConnectionServiceOptions = {
  store: RgapStore
  mcp: McpProxyRuntime
  credentialStore: CredentialStore<McpCredential>
  connections: GatewayConnectionStore
  bearerVault: BearerVault
}

export class ConnectionService {
  constructor(private readonly options: ConnectionServiceOptions) {}

  async list(userId: string) {
    return this.options.connections.list(userId).map(publicConnection)
  }

  async get(id: string, userId: string) {
    const connection = this.options.connections.get(id, userId)
    if (!connection) return undefined
    return publicConnection(connection)
  }

  async create(userId: string, input: CreateConnectionInput) {
    const serverUrl = await assertAllowedServerUrl(input.serverUrl)
    const id = `cn_${randomUUID().replaceAll('-', '')}`
    const now = new Date().toISOString()
    const admin = this.options.store.admin()
    const userSegment = createHash('sha256')
      .update(userId)
      .digest('hex')
      .slice(0, 24)
    const root = `gateway/users/${userSegment}`
    let connectionResource: ResourceHandle | undefined
    let credentialResource: ResourceHandle | undefined
    let grant: Awaited<ReturnType<RgapRepository['grants']['create']>> | undefined

    try {
      const serverResource = await ensureResource(
        admin,
        `${root}/servers/${resourceName(serverUrl)}`,
      )
      credentialResource = await ensureResource(
        admin,
        `${root}/credentials/${id}`,
      )
      await this.options.credentialStore.set(credentialResource.id, {})
      connectionResource = await ensureExecutableResource(
        admin,
        `${root}/connections/${id}`,
        {
          runtime: 'mcp',
          input: { serverUrl: serverUrl.toString() },
          bind: {
            server: serverResource.id,
            credential: credentialResource.id,
          },
        },
      )
      grant = await admin.grants.create({
        name: `${root}/grants/${id}`,
        bindings: [
          { id: connectionResource.id, permissions: ['invoke'] },
        ],
        expiresAt: null,
      })
      const issued = await grant.tokens.create({ label: `gateway-${id}` })
      const record: GatewayConnection = {
        id,
        userId,
        displayName: input.displayName,
        serverUrl: serverUrl.toString(),
        status: 'error',
        resourceId: connectionResource.id,
        credentialResourceId: credentialResource.id,
        grantId: grant.id,
        encryptedRgapBearer: this.options.bearerVault.encrypt(issued.value),
        createdAt: now,
        updatedAt: now,
      }
      this.options.connections.create(record)
      return this.refresh(record)
    } catch (error) {
      if (grant) await grant.revoke().catch(() => undefined)
      if (credentialResource) {
        await Promise.resolve(
          this.options.credentialStore.delete(credentialResource.id),
        ).catch(() => undefined)
      }
      if (connectionResource) {
        await connectionResource.delete().catch(() => undefined)
      }
      if (credentialResource) {
        await credentialResource.delete().catch(() => undefined)
      }
      this.options.connections.delete(id, userId)
      throw error
    }
  }

  async authorize(id: string, userId: string) {
    const connection = this.requireOwned(id, userId)
    return this.refresh(connection)
  }

  async delete(id: string, userId: string) {
    const connection = this.options.connections.get(id, userId)
    if (!connection) return false
    const admin = this.options.store.admin()
    const grant = await admin.grants.get(grantId(connection.grantId))
    await grant.revoke()
    await this.options.mcp
      .disconnect(
        new URL(connection.serverUrl),
        connection.credentialResourceId,
      )
      .catch(() => undefined)
    await Promise.resolve(
      this.options.credentialStore.delete(
        connection.credentialResourceId,
      ),
    )
    await deleteResourceIfPresent(admin, connection.resourceId)
    await deleteResourceIfPresent(admin, connection.credentialResourceId)
    this.options.connections.delete(id, userId)
    return true
  }

  async dispatch(request: Request, id: string, userId: string, proxy: {
    fetch(request: Request): Response | Promise<Response>
  }) {
    const connection = this.requireOwned(id, userId)
    const bearer = this.options.bearerVault.decrypt(
      connection.encryptedRgapBearer,
    )
    const target = new URL(request.url)
    target.pathname = `/mcp/${encodeURIComponent(connection.resourceId)}`
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${bearer}`)
    headers.delete('cookie')
    const delegated = new Request(target, request)
    return proxy.fetch(new Request(delegated, { headers }))
  }

  private requireOwned(id: string, userId: string) {
    const connection = this.options.connections.get(id, userId)
    if (!connection) {
      throw new Response('Connection not found.', { status: 404 })
    }
    return connection
  }

  private async refresh(connection: GatewayConnection): Promise<Connection> {
    try {
      const status = await this.options.mcp.connect(
        new URL(connection.serverUrl),
        connection.credentialResourceId,
      )
      const updated = this.options.connections.updateStatus(
        connection.id,
        connection.userId,
        status.status,
        status.status === 'authorization_required'
          ? status.authorizationUrl.toString()
          : undefined,
      )
      return publicConnection(updated ?? connection)
    } catch {
      const updated = this.options.connections.updateStatus(
        connection.id,
        connection.userId,
        'error',
      )
      return publicConnection(updated ?? connection)
    }
  }
}

function publicConnection(connection: GatewayConnection) {
  return ConnectionSchema.parse({
    id: connection.id,
    displayName: connection.displayName,
    serverUrl: connection.serverUrl,
    status: connection.status,
    ...(connection.authorizationUrl
      ? { authorizationUrl: connection.authorizationUrl }
      : {}),
  })
}

async function ensureResource(repository: RgapRepository, path: string) {
  let parent: ResourceHandle | undefined
  for (const name of path.split('/')) {
    const existing = await child(repository, parent?.id ?? null, name)
    parent =
      existing ??
      (parent
        ? await parent.create({ name })
        : await repository.resources.create({ name }))
  }
  return parent!
}

async function ensureExecutableResource(
  repository: RgapRepository,
  path: string,
  executable: SetExecutableInput,
) {
  const segments = path.split('/')
  const name = segments.pop()
  if (!name || !segments.length) {
    throw new Error('Executable resources require a parent folder.')
  }
  const parent = await ensureResource(repository, segments.join('/'))
  const existing = await child(repository, parent.id, name)
  if (existing) {
    if (!existing.executable) {
      throw new Error(`Resource ${path} exists as a folder.`)
    }
    return existing
  }
  return parent.create({ name, executable })
}

async function child(
  repository: RgapRepository,
  parentId: ResourceId | null,
  name: string,
) {
  let cursor: ResourceId | undefined
  do {
    const page = await repository.resources.list({
      parentId,
      cursor,
      limit: 100,
    })
    const match = page.find((resource) => resource.name === name)
    if (match) return repository.resources.get(match.id)
    cursor = page.length === 100 ? page.at(-1)?.id : undefined
  } while (cursor)
  return undefined
}

function resourceName(url: URL) {
  const path = url.pathname.split('/').filter(Boolean).join('-')
  const label = `${url.protocol.slice(0, -1)}-${url.host}${
    path ? `-${path}` : ''
  }`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
  const digest = createHash('sha256')
    .update(url.toString())
    .digest('hex')
    .slice(0, 8)
  return `${label}-${digest}`
}

async function deleteResourceIfPresent(
  repository: RgapRepository,
  id: string,
) {
  try {
    const resource = await repository.resources.get(resourceId(id))
    await resource.delete()
  } catch (error) {
    if (error instanceof RgapError && error.code === 'missing_resource') return
    throw error
  }
}
