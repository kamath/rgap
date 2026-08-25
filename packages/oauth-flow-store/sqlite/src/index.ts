import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

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

export type SqliteOAuthFlowStoreOptions = {
  url?: string;
};

type StoredOAuthFlow = {
  flow_id: string;
  credential_id: string;
  server_url: string;
  expires_at: string;
  claimed_at: string | null;
};

export class SqliteOAuthFlowStore implements OAuthFlowStore {
  readonly #database: Database.Database;
  readonly #register: Database.Statement;
  readonly #select: Database.Statement<[string], StoredOAuthFlow>;
  readonly #claim: Database.Statement<[string, string]>;
  readonly #complete: Database.Statement<[string]>;
  readonly #claimTransaction: (
    stateHash: string,
    now: Date,
  ) => OAuthFlowRecord;

  constructor(options: SqliteOAuthFlowStoreOptions = {}) {
    this.#database = new Database(options.url ?? ':memory:');
    this.#database.pragma('busy_timeout = 5000');
    this.#database.pragma('journal_mode = WAL');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        server_url TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT
      )
    `);
    this.#register = this.#database.prepare(`
      INSERT INTO oauth_flows (
        state_hash,
        flow_id,
        credential_id,
        server_url,
        expires_at,
        claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (state_hash) DO UPDATE SET
        flow_id = excluded.flow_id,
        credential_id = excluded.credential_id,
        server_url = excluded.server_url,
        expires_at = excluded.expires_at,
        claimed_at = excluded.claimed_at
      WHERE oauth_flows.claimed_at IS NULL
    `);
    this.#select = this.#database.prepare(`
      SELECT flow_id, credential_id, server_url, expires_at, claimed_at
      FROM oauth_flows
      WHERE state_hash = ?
    `);
    this.#claim = this.#database.prepare(`
      UPDATE oauth_flows
      SET claimed_at = ?
      WHERE state_hash = ?
    `);
    this.#complete = this.#database.prepare(`
      DELETE FROM oauth_flows
      WHERE state_hash = ?
    `);
    this.#claimTransaction = this.#database.transaction(
      (stateHash: string, now: Date) => {
        const stored = this.#select.get(stateHash);
        if (!stored) throw new Error('The OAuth callback state is invalid.');
        if (stored.claimed_at) {
          throw new Error('The OAuth callback was already consumed.');
        }
        if (new Date(stored.expires_at).getTime() <= now.getTime()) {
          throw new Error('The OAuth callback has expired.');
        }
        const claimedAt = now.toISOString();
        this.#claim.run(claimedAt, stateHash);
        return fromStored(stored, claimedAt);
      },
    ).immediate;
  }

  async register(state: string, flow: OAuthFlowRecord) {
    this.#register.run(
      stateKey(state),
      flow.flowId,
      flow.credentialId,
      flow.serverUrl,
      flow.expiresAt,
      flow.claimedAt ?? null,
    );
  }

  async claim(state: string, now = new Date()) {
    return this.#claimTransaction(stateKey(state), now);
  }

  async complete(state: string) {
    this.#complete.run(stateKey(state));
  }

  async close() {
    this.#database.close();
  }
}

function stateKey(state: string) {
  return createHash('sha256').update(state).digest('hex');
}

function fromStored(
  stored: StoredOAuthFlow,
  claimedAt = stored.claimed_at ?? undefined,
): OAuthFlowRecord {
  return {
    flowId: stored.flow_id,
    credentialId: stored.credential_id,
    serverUrl: stored.server_url,
    expiresAt: stored.expires_at,
    ...(claimedAt ? { claimedAt } : {}),
  };
}
