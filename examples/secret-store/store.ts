import Database from 'better-sqlite3';

type Awaitable<T> = T | Promise<T>;

export interface SecretStore {
  get(resourceId: string): Awaitable<string | undefined>;
  set(resourceId: string, value: string): Awaitable<void>;
  close(): Awaitable<void>;
}

export class SqliteSecretStore implements SecretStore {
  readonly #database: Database.Database;
  readonly #select: Database.Statement<[string], { value: string }>;
  readonly #set: Database.Statement<[string, string]>;

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

  get(resourceId: string) {
    return this.#select.get(resourceId)?.value;
  }

  set(resourceId: string, value: string) {
    this.#set.run(resourceId, value);
  }

  close() {
    this.#database.close();
  }
}
