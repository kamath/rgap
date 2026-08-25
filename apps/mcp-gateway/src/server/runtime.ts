import { SqliteCredentialStore } from '@rgap/credential-store-sqlite'
import {
  createMcpProxyApp,
  createMcpProxyRuntime,
  type McpCredential,
} from '@rgap/mcp-proxy'
import { SqliteOAuthFlowStore } from '@rgap/oauth-flow-store-sqlite'
import { SqliteRgapStore } from '@rgap/store-sqlite'
import { BearerVault } from './bearer-vault'
import { ConnectionService } from './connection-service'
import { GatewayConnectionStore } from './connection-store'
import {
  appUrl,
  bearerEncryptionKey,
  dataPath,
} from './config'

function createRuntime() {
  const credentialStore = new SqliteCredentialStore<McpCredential>({
    url: dataPath('credentials.db'),
  })
  const flowStore = new SqliteOAuthFlowStore({
    url: dataPath('oauth-flows.db'),
  })
  const mcp = createMcpProxyRuntime({
    publicBaseUrl: appUrl,
    credentialStore,
    flowStore,
  })
  const store = new SqliteRgapStore({
    url: dataPath('rgap.db'),
    runtimes: { mcp: mcp.runtime },
  })
  const connections = new GatewayConnectionStore(dataPath('gateway.db'))
  const proxy = createMcpProxyApp({
    mcp,
    store,
    onAuthorizationComplete: (status) => {
      if (status.status !== 'connected') return
      const connection = connections.getByCredentialId(status.credentialId)
      if (connection) {
        connections.updateStatus(
          connection.id,
          connection.userId,
          'connected',
        )
      }
    },
  })
  const service = new ConnectionService({
    store,
    mcp,
    credentialStore,
    connections,
    bearerVault: new BearerVault(bearerEncryptionKey()),
  })

  return {
    mcp,
    store,
    credentialStore,
    flowStore,
    connections,
    proxy,
    service,
    async close() {
      await mcp.close()
      store.close()
      credentialStore.close()
      await flowStore.close()
      connections.close()
    },
  }
}

type GatewayRuntime = ReturnType<typeof createRuntime>

const runtimeKey = Symbol.for('@rgap/mcp-gateway/runtime')
const shutdownKey = Symbol.for('@rgap/mcp-gateway/shutdown')
const globalRuntime = globalThis as typeof globalThis & {
  [runtimeKey]?: GatewayRuntime
  [shutdownKey]?: boolean
}

export const gatewayRuntime =
  globalRuntime[runtimeKey] ??= createRuntime()

if (!globalRuntime[shutdownKey]) {
  globalRuntime[shutdownKey] = true
  const shutdown = () => {
    gatewayRuntime
      .close()
      .catch((error: unknown) => {
        console.error('MCP gateway shutdown failed.', error)
      })
      .finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
