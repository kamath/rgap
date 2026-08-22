import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { RgapError, type ResourceId, type SecretMetadata, type SecretStore } from '@rgap/core';

type SecretRow = {
  resource_id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  version: number;
  updated_at: string;
};

export class EncryptedSqliteSecretStore implements SecretStore {
  #connection?: Database.Database;

  constructor(
    private readonly url: string,
    private readonly key: () => Buffer,
  ) {}

  async write(resourceId: ResourceId, value: string): Promise<SecretMetadata> {
    const connection = this.connection();
    const previous = connection.prepare(
      'select version from llm_gateway_secrets where resource_id = ?',
    ).get(resourceId) as Pick<SecretRow, 'version'> | undefined;
    const version = (previous?.version ?? 0) + 1;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(`${resourceId}:${version}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const updatedAt = new Date().toISOString();
    connection.prepare(`
      insert into llm_gateway_secrets (resource_id, ciphertext, nonce, tag, version, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(resource_id) do update set
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        tag = excluded.tag,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(resourceId, ciphertext, nonce, tag, version, updatedAt);
    return { resourceId, version: String(version), updatedAt };
  }

  async delete(resourceId: ResourceId) {
    this.connection().prepare(
      'delete from llm_gateway_secrets where resource_id = ?',
    ).run(resourceId);
  }

  async handle(resourceId: ResourceId) {
    return { resourceId, kind: 'secret' as const };
  }

  read(resourceId: ResourceId) {
    const row = this.connection().prepare(
      'select * from llm_gateway_secrets where resource_id = ?',
    ).get(resourceId) as SecretRow | undefined;
    if (!row) throw new RgapError('missing_secret', 'OpenAI secret does not exist.');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), row.nonce);
    decipher.setAAD(Buffer.from(`${resourceId}:${row.version}`));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  close() {
    this.#connection?.close();
    this.#connection = undefined;
  }

  private connection() {
    if (this.#connection) return this.#connection;
    const connection = new Database(this.url);
    connection.pragma('foreign_keys = ON');
    connection.exec(`
      create table if not exists llm_gateway_secrets (
        resource_id text primary key,
        ciphertext blob not null,
        nonce blob not null,
        tag blob not null,
        version integer not null,
        updated_at text not null
      )
    `);
    this.#connection = connection;
    return connection;
  }
}

export function secretKey() {
  const encoded = process.env.RGAP_SECRET_KEY?.trim();
  if (!encoded) throw new Error('RGAP_SECRET_KEY is required.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('RGAP_SECRET_KEY must be a base64-encoded 32-byte key.');
  return key;
}
