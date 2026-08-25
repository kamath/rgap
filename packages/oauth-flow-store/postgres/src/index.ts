import { createHash } from 'node:crypto';
import postgres, {
  type Options,
  type Sql,
} from 'postgres';

export type OAuthFlowRecord = {
  flowId: string;
  credentialId: string;
  serverUrl: string;
  expiresAt: string;
  claimedAt?: string;
};

export interface OAuthFlowStore {
  register(state: string, flow: OAuthFlowRecord): Promise<void>;
  claim(state: string, now?: Date): Promise<OAuthFlowRecord>;
  complete(state: string): Promise<void>;
  close(): Promise<void>;
}

export type PostgresOAuthFlowStoreOptions = {
  url: string;
  connection?: Options<Record<string, never>>;
};

type StoredOAuthFlow = {
  flow_id: string;
  credential_id: string;
  server_url: string;
  expires_at: string;
  claimed_at: string | null;
};

export class PostgresOAuthFlowStore implements OAuthFlowStore {
  readonly #connection: Sql;

  constructor(options: PostgresOAuthFlowStoreOptions) {
    this.#connection = postgres(options.url, options.connection);
  }

  async migrate() {
    await this.#connection`
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        server_url TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT
      )
    `;
  }

  async register(state: string, flow: OAuthFlowRecord) {
    await this.#connection`
      INSERT INTO oauth_flows (
        state_hash,
        flow_id,
        credential_id,
        server_url,
        expires_at,
        claimed_at
      ) VALUES (
        ${stateKey(state)},
        ${flow.flowId},
        ${flow.credentialId},
        ${flow.serverUrl},
        ${flow.expiresAt},
        ${flow.claimedAt ?? null}
      )
      ON CONFLICT (state_hash) DO UPDATE SET
        flow_id = excluded.flow_id,
        credential_id = excluded.credential_id,
        server_url = excluded.server_url,
        expires_at = excluded.expires_at,
        claimed_at = excluded.claimed_at
    `;
  }

  async claim(state: string, now = new Date()) {
    const stateHash = stateKey(state);
    const claimedAt = now.toISOString();
    return this.#connection.begin(async (transaction) => {
      const [claimed] = await transaction<StoredOAuthFlow[]>`
        UPDATE oauth_flows
        SET claimed_at = ${claimedAt}
        WHERE state_hash = ${stateHash}
          AND claimed_at IS NULL
          AND expires_at > ${claimedAt}
        RETURNING flow_id, credential_id, server_url, expires_at, claimed_at
      `;
      if (claimed) return fromStored(claimed);

      const [stored] = await transaction<StoredOAuthFlow[]>`
        SELECT flow_id, credential_id, server_url, expires_at, claimed_at
        FROM oauth_flows
        WHERE state_hash = ${stateHash}
      `;
      if (!stored) throw new Error('The OAuth callback state is invalid.');
      if (stored.claimed_at) {
        throw new Error('The OAuth callback was already consumed.');
      }
      throw new Error('The OAuth callback has expired.');
    });
  }

  async complete(state: string) {
    await this.#connection`
      DELETE FROM oauth_flows
      WHERE state_hash = ${stateKey(state)}
    `;
  }

  async close() {
    await this.#connection.end();
  }
}

function stateKey(state: string) {
  return createHash('sha256').update(state).digest('hex');
}

function fromStored(stored: StoredOAuthFlow): OAuthFlowRecord {
  return {
    flowId: stored.flow_id,
    credentialId: stored.credential_id,
    serverUrl: stored.server_url,
    expiresAt: stored.expires_at,
    ...(stored.claimed_at ? { claimedAt: stored.claimed_at } : {}),
  };
}
