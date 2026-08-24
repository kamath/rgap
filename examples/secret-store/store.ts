import type { ResourceId } from '@rgap/core';
import Database from 'better-sqlite3';

type Awaitable<T> = T | Promise<T>;

export interface SecretStore {
  get(resourceId: ResourceId): Awaitable<string | undefined>;
  set(resourceId: ResourceId, value: string): Awaitable<void>;
  close(): Awaitable<void>;
}

export class SqliteSecretStore implements SecretStore {
  readonly #database: Database.Database;
  readonly #select: Database.Statement<[ResourceId], { value: string }>;
  readonly #set: Database.Statement<[ResourceId, string]>;

  constructor(url: string) {
    this.#database = new Database(url);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        resource_id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.#select = this.#database.prepare(
      'SELECT value FROM secrets WHERE resource_id = ?',
    );
    this.#set = this.#database.prepare(`
      INSERT INTO secrets (resource_id, value) VALUES (?, ?)
      ON CONFLICT (resource_id) DO UPDATE SET value = excluded.value
    `);
  }

  get(resourceId: ResourceId) {
    return this.#select.get(resourceId)?.value;
  }

  set(resourceId: ResourceId, value: string) {
    this.#set.run(resourceId, value);
  }

  close() {
    this.#database.close();
  }
}
