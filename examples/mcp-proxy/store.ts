import Database from 'better-sqlite3';

type Awaitable<T> = T | Promise<T>;

export interface SecretStore {
  get(key: string): Awaitable<string | undefined>;
  set(key: string, value: string): Awaitable<void>;
  delete(key: string): Awaitable<void>;
  close(): Awaitable<void>;
}

export class SqliteSecretStore implements SecretStore {
  readonly #database: Database.Database;
  readonly #select: Database.Statement<[string], { value: string }>;
  readonly #set: Database.Statement<[string, string]>;
  readonly #delete: Database.Statement<[string]>;

  constructor(url: string) {
    this.#database = new Database(url);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.#select = this.#database.prepare(
      'SELECT value FROM secrets WHERE key = ?',
    );
    this.#set = this.#database.prepare(`
      INSERT INTO secrets (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);
    this.#delete = this.#database.prepare('DELETE FROM secrets WHERE key = ?');
  }

  get(key: string) {
    return this.#select.get(key)?.value;
  }

  set(key: string, value: string) {
    this.#set.run(key, value);
  }

  delete(key: string) {
    this.#delete.run(key);
  }

  close() {
    this.#database.close();
  }
}
