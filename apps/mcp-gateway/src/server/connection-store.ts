import Database from 'better-sqlite3'
import type { ConnectionStatus } from '../shared/connections'

export type GatewayConnection = {
  id: string
  userId: string
  displayName: string
  serverUrl: string
  status: ConnectionStatus
  authorizationUrl?: string
  resourceId: string
  credentialResourceId: string
  grantId: string
  encryptedRgapBearer: string
  createdAt: string
  updatedAt: string
}

type ConnectionRow = {
  id: string
  user_id: string
  display_name: string
  server_url: string
  status: ConnectionStatus
  authorization_url: string | null
  resource_id: string
  credential_resource_id: string
  grant_id: string
  encrypted_rgap_bearer: string
  created_at: string
  updated_at: string
}

export class GatewayConnectionStore {
  private readonly database: Database.Database

  constructor(url: string) {
    this.database = new Database(url)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('authorization_required', 'connected', 'error')
        ),
        authorization_url TEXT,
        resource_id TEXT NOT NULL UNIQUE,
        credential_resource_id TEXT NOT NULL UNIQUE,
        grant_id TEXT NOT NULL UNIQUE,
        encrypted_rgap_bearer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gateway_connections_user_id
        ON gateway_connections (user_id, created_at, id);
    `)
  }

  create(connection: GatewayConnection) {
    this.database
      .prepare(`
        INSERT INTO gateway_connections (
          id, user_id, display_name, server_url, status, authorization_url,
          resource_id, credential_resource_id, grant_id,
          encrypted_rgap_bearer, created_at, updated_at
        ) VALUES (
          @id, @userId, @displayName, @serverUrl, @status, @authorizationUrl,
          @resourceId, @credentialResourceId, @grantId,
          @encryptedRgapBearer, @createdAt, @updatedAt
        )
      `)
      .run({
        ...connection,
        authorizationUrl: connection.authorizationUrl ?? null,
      })
  }

  list(userId: string) {
    const rows = this.database
      .prepare(`
        SELECT * FROM gateway_connections
        WHERE user_id = ?
        ORDER BY created_at, id
      `)
      .all(userId) as ConnectionRow[]
    return rows.map(fromRow)
  }

  get(id: string, userId: string) {
    const row = this.database
      .prepare(`
        SELECT * FROM gateway_connections
        WHERE id = ? AND user_id = ?
      `)
      .get(id, userId) as ConnectionRow | undefined
    return row ? fromRow(row) : undefined
  }

  getByCredentialId(credentialResourceId: string) {
    const row = this.database
      .prepare(`
        SELECT * FROM gateway_connections
        WHERE credential_resource_id = ?
      `)
      .get(credentialResourceId) as ConnectionRow | undefined
    return row ? fromRow(row) : undefined
  }

  updateStatus(
    id: string,
    userId: string,
    status: ConnectionStatus,
    authorizationUrl?: string,
  ) {
    const updatedAt = new Date().toISOString()
    const result = this.database
      .prepare(`
        UPDATE gateway_connections
        SET status = ?, authorization_url = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(status, authorizationUrl ?? null, updatedAt, id, userId)
    if (result.changes !== 1) return undefined
    return this.get(id, userId)
  }

  delete(id: string, userId: string) {
    return this.database.transaction(() => {
      const connection = this.get(id, userId)
      if (!connection) return undefined
      this.database
        .prepare(
          'DELETE FROM gateway_connections WHERE id = ? AND user_id = ?',
        )
        .run(id, userId)
      return connection
    })()
  }

  close() {
    this.database.close()
  }
}

function fromRow(row: ConnectionRow): GatewayConnection {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    serverUrl: row.server_url,
    status: row.status,
    ...(row.authorization_url
      ? { authorizationUrl: row.authorization_url }
      : {}),
    resourceId: row.resource_id,
    credentialResourceId: row.credential_resource_id,
    grantId: row.grant_id,
    encryptedRgapBearer: row.encrypted_rgap_bearer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
